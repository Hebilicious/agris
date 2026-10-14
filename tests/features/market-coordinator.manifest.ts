import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  PearlAbyssCoordinatorQueueFullError,
  PearlAbyssInFlightCoordinator,
  pearlAbyssRequestKey,
} from "../../packages/pearl-abyss/src/server/index.ts";
import {
  PEARL_ABYSS_REGIONS,
  type PearlAbyssRegion,
} from "../../packages/pearl-abyss/src/protocol/region-descriptor.ts";
import {
  maximumConcurrentRequestsFromBinding,
  MAXIMUM_QUEUED_PEARL_ABYSS_REQUESTS,
  PearlAbyssCoordination,
  pearlAbyssCoordinatorAddress,
  type PearlAbyssCoordinatorClock,
  type PearlAbyssCoordinatorLocation,
  type PearlAbyssCoordinatorPort,
  type PearlAbyssRateLimiter,
} from "../../apps/market/src/market.ts";
import {
  integerStepArgument,
  noStepArguments,
  step,
  type ExecutableFeatureManifest,
  type StepDefinition,
} from "../support/manifest.ts";

const FAILURE_HEADER = "X-Pearl-Abyss-Failure";

interface PendingCall {
  settled: boolean;
  readonly response: Promise<Response>;
}

interface MarketCoordinatorWorld {
  upstream?: FakeUpstream;
  coordinatorFor?: (hostname: string) => PearlAbyssCoordinatorPort;
  calls?: PendingCall[];
  failures?: readonly (string | null)[];
  answers?: readonly string[];
  abandoned?: readonly AbortController[];
  clock?: FakeClock;
  permitsAsked?: number;
  inFlight?: PearlAbyssInFlightCoordinator<string, string>;
  releaseAdmission?: () => void;
}

const steps: readonly StepDefinition<MarketCoordinatorWorld>[] = [
  step(
    "a coordinator that runs one Pearl Abyss request at once and whose rate limit admits only the first",
    noStepArguments,
    (world) => {
      world.upstream = new FakeUpstream({ gated: true });
      world.coordinatorFor = deployment(world, world.upstream, {
        maximumConcurrentRequests: 1,
        limiterAt: perLocationLimiter(1),
      });
    },
  ),
  step("a second distinct request arrives while the first is still in flight", noStepArguments, async (world) => {
    const coordinatorFor = required(world.coordinatorFor);
    const upstream = required(world.upstream);
    const first = track(coordinatorFor(hostOf("EU")).execute(pearlAbyssRequest("EU", "10006")));
    await waitFor(() => upstream.requests.length === 1);
    const second = track(coordinatorFor(hostOf("EU")).execute(pearlAbyssRequest("EU", "10009")));
    world.calls = [first, second];
  }),
  step("the second fails as rate limited before the first settles", noStepArguments, async (world) => {
    const [first, second] = required(world.calls);
    const upstream = required(world.upstream);
    try {
      await waitFor(() => required(second).settled);
      assert.equal(required(first).settled, false);
      assert.equal((await required(second).response).headers.get(FAILURE_HEADER), "upstream/rate-limited");
    } finally {
      upstream.release();
      await Promise.allSettled(required(world.calls).map((call) => call.response));
    }
  }),

  step("a coordinator that runs one Pearl Abyss request at once", noStepArguments, (world) => {
    world.upstream = new FakeUpstream({ gated: true });
    world.coordinatorFor = deployment(world, world.upstream, {
      maximumConcurrentRequests: 1,
      limiterAt: () => undefined,
    });
  }),
  step(
    "{int} distinct requests arrive while the first is still in flight",
    integerStepArgument,
    async (world, count) => {
      const coordinator = required(world.coordinatorFor)(hostOf("EU"));
      const upstream = required(world.upstream);
      const calls = [track(coordinator.execute(pearlAbyssRequest("EU", "1")))];
      await waitFor(() => upstream.requests.length === 1);
      for (let index = 1; index < count; index += 1) {
        calls.push(track(coordinator.execute(pearlAbyssRequest("EU", String(index + 1)))));
      }
      world.calls = calls;
    },
  ),
  step("one of them fails as queue full without reaching Pearl Abyss", noStepArguments, async (world) => {
    const calls = required(world.calls);
    try {
      await waitFor(() => calls.some((call) => call.settled));
      // Requests reach the coordinator once their bodies are hashed, in no fixed order: let every one arrive.
      await settle();
    } catch (error: unknown) {
      required(world.upstream).release();
      await Promise.allSettled(calls.map((call) => call.response));
      throw error;
    }
    assert.equal(calls.length, 1 + MAXIMUM_QUEUED_PEARL_ABYSS_REQUESTS + 1);
    const refused = calls.filter((call) => call.settled);
    assert.equal(refused.length, 1);
    assert.equal(required(calls[0]).settled, false);
    assert.equal((await required(refused[0]).response).headers.get(FAILURE_HEADER), "upstream/queue-full");
    assert.equal(required(world.upstream).requests.length, 1);
    world.calls = calls.filter((call) => !call.settled);
  }),
  step(
    "once the first settles, the {int} admitted requests are answered",
    integerStepArgument,
    async (world, count) => {
      const upstream = required(world.upstream);
      upstream.release();
      const admitted = required(world.calls);
      assert.equal(admitted.length, count);
      const statuses = await Promise.all(admitted.map(async (call) => (await call.response).status));
      assert.deepEqual(new Set(statuses), new Set([200]));
      assert.equal(upstream.requests.length, count);
    },
  ),

  step("the coordinator key of a Pearl Abyss request is derived", noStepArguments, async (world) => {
    const url = `https://${hostOf("EU")}/Trademarket/GetWorldMarketSearchList`;
    const body = "x".repeat(65_536);
    world.answers = [
      await pearlAbyssRequestKey(url, body),
      createHash("sha256").update(`${url}\n${body}`).digest("hex"),
    ];
  }),
  step("it is the hex SHA-256 of the request's URL and body", noStepArguments, (world) => {
    const [key, expected] = required(world.answers);
    assert.match(required(key), /^[0-9a-f]{64}$/u);
    assert.equal(key, expected);
  }),

  step("two callers share one pending Pearl Abyss request and the first gives up", noStepArguments, async (world) => {
    const upstream = new FakeUpstream({ gated: true });
    world.upstream = upstream;
    const coordinator = deployment(world, upstream, { maximumConcurrentRequests: 6, limiterAt: () => undefined })(
      hostOf("EU"),
    );
    const first = new AbortController();
    const second = new AbortController();
    const firstCall = track(coordinator.execute(pearlAbyssRequest("EU", "10006", first.signal)));
    const secondCall = track(coordinator.execute(pearlAbyssRequest("EU", "10006", second.signal)));
    await waitFor(() => upstream.requests.length === 1);
    // Both callers have joined once each one's body is read and hashed.
    await settle();
    first.abort(new Error("The first caller gave up"));
    await Promise.allSettled([firstCall.response]);
    upstream.release();
    const response = await secondCall.response;
    world.answers = [String(response.status), await response.text()];
  }),
  step(
    "the second caller still receives the Pearl Abyss answer from one upstream request",
    noStepArguments,
    (world) => {
      assert.deepEqual(world.answers, ["200", answerFor("10006")]);
      assert.equal(required(world.upstream).requests.length, 1);
    },
  ),

  step("both callers sharing one pending Pearl Abyss request give up", noStepArguments, async (world) => {
    const upstream = new FakeUpstream({ gated: true });
    world.upstream = upstream;
    const coordinator = deployment(world, upstream, { maximumConcurrentRequests: 6, limiterAt: () => undefined })(
      hostOf("EU"),
    );
    const callers = [new AbortController(), new AbortController()];
    const calls = callers.map((caller) => track(coordinator.execute(pearlAbyssRequest("EU", "10006", caller.signal))));
    await waitFor(() => upstream.requests.length === 1);
    await settle();
    for (const caller of callers) caller.abort(new Error("The caller gave up"));
    await Promise.allSettled(calls.map((call) => call.response));
    world.abandoned = callers;
  }),
  step("the upstream request is cancelled", noStepArguments, async (world) => {
    const upstream = required(world.upstream);
    await waitFor(() => upstream.cancelled === 1);
    assert.equal(upstream.requests.length, 1);
  }),

  step("{int} seconds pass while Pearl Abyss holds the first", integerStepArgument, async (world, seconds) => {
    const calls = required(world.calls);
    const clock = required(world.clock);
    try {
      // The second request reaches the coordinator once its body is read and hashed; its deadline starts there.
      await settle();
      clock.advance(seconds * 1_000 - 1);
      await settle();
      assert.deepEqual(
        calls.map((call) => call.settled),
        calls.map(() => false),
      );
      clock.advance(1);
      await waitFor(() => calls.every((call) => call.settled));
    } finally {
      required(world.upstream).release();
      await Promise.allSettled(calls.map((call) => call.response));
    }
  }),
  step(
    "both fail as timed out, the first's upstream call is cancelled, and the second never reaches Pearl Abyss",
    noStepArguments,
    async (world) => {
      const upstream = required(world.upstream);
      const failures = await Promise.all(
        required(world.calls).map(async (call) => (await call.response).headers.get(FAILURE_HEADER)),
      );
      assert.deepEqual(failures, ["upstream/timeout", "upstream/timeout"]);
      assert.equal(upstream.cancelled, 1);
      assert.equal(upstream.requests.length, 1);
    },
  ),

  step("a coordinator whose Pearl Abyss rate limiter never answers", noStepArguments, (world) => {
    world.upstream = new FakeUpstream();
    world.coordinatorFor = deployment(world, world.upstream, {
      maximumConcurrentRequests: 6,
      limiterAt: () => ({ limit: () => new Promise<never>(() => {}) }),
    });
  }),
  step("a distinct request waits {int} seconds for its permit", integerStepArgument, async (world, seconds) => {
    const call = track(required(world.coordinatorFor)(hostOf("EU")).execute(pearlAbyssRequest("EU", "10006")));
    world.calls = [call];
    await waitFor(() => world.permitsAsked === 1);
    required(world.clock).advance(seconds * 1_000);
    await waitFor(() => call.settled);
  }),
  step("it fails as rate limited without reaching Pearl Abyss", noStepArguments, async (world) => {
    const [call] = required(world.calls);
    assert.equal((await required(call).response).headers.get(FAILURE_HEADER), "upstream/rate-limited");
    assert.equal(required(world.upstream).requests.length, 0);
  }),
  step(
    "an in-flight coordinator that holds one distinct request at most and whose admission ignores cancellation",
    noStepArguments,
    (world) => {
      const admissions: (() => void)[] = [];
      world.releaseAdmission = () => {
        for (const admitted of admissions.splice(0)) admitted();
      };
      world.inFlight = new PearlAbyssInFlightCoordinator<string, string>(
        { maximumActiveRequests: 1, maximumQueuedRequests: 0 },
        {
          admit: () =>
            new Promise<undefined>((resolve) => {
              admissions.push(() => resolve(undefined));
            }),
          send: async (request) => request,
        },
      );
    },
  ),
  step("the only caller of a distinct request gives up while it is being admitted", noStepArguments, async (world) => {
    const caller = new AbortController();
    const abandoned = required(world.inFlight).execute("first", "first", caller.signal);
    caller.abort(new Error("The caller gave up"));
    await assert.rejects(abandoned, /The caller gave up/u);
  }),
  step(
    "another distinct request fails as queue full until the abandoned one settles",
    noStepArguments,
    async (world) => {
      const inFlight = required(world.inFlight);
      try {
        await assert.rejects(inFlight.execute("second", "second"), PearlAbyssCoordinatorQueueFullError);
      } finally {
        required(world.releaseAdmission)();
      }
      await settle();
      const third = inFlight.execute("third", "third");
      await settle();
      required(world.releaseAdmission)();
      assert.equal(await third, "third");
    },
  ),

  step("a coordinator whose PA_MAX_CONCURRENT_REQUESTS is {int}", integerStepArgument, (world, setting) => {
    world.upstream = new FakeUpstream({ gated: true });
    world.coordinatorFor = deployment(world, world.upstream, {
      maximumConcurrentRequests: maximumConcurrentRequestsFromBinding(setting),
      limiterAt: () => undefined,
    });
  }),
  step("{int} distinct requests arrive while Pearl Abyss holds every answer", integerStepArgument, (world, count) => {
    const coordinator = required(world.coordinatorFor)(hostOf("EU"));
    world.calls = Array.from({ length: count }, (_value, index) =>
      track(coordinator.execute(pearlAbyssRequest("EU", String(index + 1)))),
    );
  }),
  step("{int} reach Pearl Abyss and one fails as queue full", integerStepArgument, async (world, sent) => {
    const calls = required(world.calls);
    const upstream = required(world.upstream);
    try {
      await waitFor(() => calls.some((call) => call.settled) && upstream.requests.length >= sent);
      await settle();
      const refused = calls.filter((call) => call.settled);
      assert.equal(refused.length, 1);
      assert.equal((await required(refused[0]).response).headers.get(FAILURE_HEADER), "upstream/queue-full");
      assert.equal(upstream.requests.length, sent);
    } finally {
      upstream.release();
      await Promise.allSettled(calls.map((call) => call.response));
    }
  }),
];

export const marketCoordinatorFeature: ExecutableFeatureManifest<MarketCoordinatorWorld> = {
  id: "market-coordinator",
  uri: "tests/features/market-coordinator.feature",
  createWorld: () => ({}),
  steps,
};

/** A Pearl Abyss host that records what reaches it, can hold every answer until released, and honors cancellation. */
class FakeUpstream {
  public readonly requests: string[] = [];
  public cancelled = 0;
  private readonly gated: boolean;
  private open: Promise<void>;
  private openGate = (): void => {};

  public constructor(options: { readonly gated?: boolean } = {}) {
    this.gated = options.gated ?? false;
    this.open = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
  }

  public release(): void {
    this.openGate();
  }

  public readonly fetch = async (request: Request): Promise<Response> => {
    const body = await request.text();
    this.requests.push(body);
    if (this.gated) {
      await new Promise<void>((resolve, reject) => {
        const cancel = (): void => {
          this.cancelled += 1;
          reject(request.signal.reason);
        };
        if (request.signal.aborted) {
          cancel();
          return;
        }
        request.signal.addEventListener("abort", cancel, { once: true });
        void this.open.then(() => {
          request.signal.removeEventListener("abort", cancel);
          resolve();
        });
      });
    }
    return new Response(answerFor(searchResultOf(body)), { status: 200 });
  };
}

/**
 * Every coordinator of one deployment, addressed as the market Worker addresses them. Each coordinator gets the
 * limiter of the location it runs in, as a `PA_RATE_LIMITER` binding behaves there. They all read one clock, which
 * moves only when a step advances it (`world.clock`), and every permit a coordinator asks its limiter for counts in
 * `world.permitsAsked`.
 */
function deployment(
  world: MarketCoordinatorWorld,
  upstream: FakeUpstream,
  options: {
    readonly maximumConcurrentRequests: number;
    readonly limiterAt: (location: PearlAbyssCoordinatorLocation) => PearlAbyssRateLimiter | undefined;
  },
): (hostname: string) => PearlAbyssCoordinatorPort {
  const clock = new FakeClock();
  world.clock = clock;
  world.permitsAsked = 0;
  const coordinators = new Map<string, PearlAbyssCoordinatorPort>();
  return (hostname) => {
    const address = pearlAbyssCoordinatorAddress(hostname);
    const existing = coordinators.get(address.name);
    if (existing !== undefined) return existing;
    const limiter = options.limiterAt(address.locationHint);
    const created = new PearlAbyssCoordination({
      maximumConcurrentRequests: options.maximumConcurrentRequests,
      limiter:
        limiter === undefined
          ? undefined
          : {
              limit: (permit) => {
                world.permitsAsked = (world.permitsAsked ?? 0) + 1;
                return limiter.limit(permit);
              },
            },
      upstream: upstream.fetch,
      clock,
    });
    coordinators.set(address.name, created);
    return created;
  };
}

/** A clock that stands still until a step advances it; each timeout aborts once the clock reaches it. */
class FakeClock implements PearlAbyssCoordinatorClock {
  private current = 0;
  private readonly timers: { readonly at: number; readonly controller: AbortController }[] = [];

  public now(): number {
    return this.current;
  }

  public timeout(milliseconds: number): AbortSignal {
    const controller = new AbortController();
    this.timers.push({ at: this.current + milliseconds, controller });
    return controller.signal;
  }

  public advance(milliseconds: number): void {
    this.current += milliseconds;
    for (const timer of this.timers) {
      if (timer.at <= this.current && !timer.controller.signal.aborted) {
        timer.controller.abort(new DOMException("The operation timed out", "TimeoutError"));
      }
    }
  }
}

/** Workers rate limits count per Cloudflare location: each location keeps its own counter for the same key. */
function perLocationLimiter(limit: number): (location: PearlAbyssCoordinatorLocation) => PearlAbyssRateLimiter {
  const counters = new Map<string, number>();
  return (location) => ({
    limit: async ({ key }) => {
      const counter = `${location}:${key}`;
      const used = counters.get(counter) ?? 0;
      counters.set(counter, used + 1);
      return { success: used < limit };
    },
  });
}

function hostOf(region: PearlAbyssRegion): string {
  const descriptor = PEARL_ABYSS_REGIONS.find((candidate) => candidate.code === region);
  if (descriptor === undefined) throw new Error(`No Pearl Abyss region ${region}`);
  return descriptor.host;
}

function pearlAbyssRequest(region: PearlAbyssRegion, searchResult: string, signal?: AbortSignal): Request {
  return new Request(`https://${hostOf(region)}/Trademarket/GetWorldMarketSearchList`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyType: 0, searchResult }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function searchResultOf(body: string): string {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || !("searchResult" in parsed)) throw new TypeError("No item");
  return String(parsed.searchResult);
}

function answerFor(searchResult: string): string {
  return JSON.stringify({ resultCode: 0, resultMsg: `${searchResult}-0-377000-114184` });
}

function track(response: Promise<Response>): PendingCall {
  const call: PendingCall = {
    settled: false,
    response: response.finally(() => {
      call.settled = true;
    }),
  };
  void call.response.catch(() => undefined);
  return call;
}

function required<Value>(value: Value | undefined): Value {
  assert.ok(value !== undefined);
  return value;
}

/** Let every pending promise callback and queued task run. */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for the coordinator fixture state");
}
