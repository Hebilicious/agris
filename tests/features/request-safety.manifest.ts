import assert from "node:assert/strict";

import {
  InvocationBudget,
  MarketSummaryOperationBudget,
  marketSummaryRequestLimitFor,
  marketSummaryReservation,
  subrequestLimitFromBinding,
  type MarketSummaryAdmission,
  type MarketSummaryBudgetTelemetryEvent,
} from "../../packages/invocation-budget/src/index.ts";
import {
  type BoundedGatewayResponseBody,
  MAXIMUM_GATEWAY_REQUEST_BYTES,
  MAXIMUM_GATEWAY_RESPONSE_BYTES,
  readBoundedGatewayRequestBody,
  readBoundedGatewayResponseBody,
} from "../../packages/core/src/service-binding-machine.ts";
import {
  createPearlAbyssMarketReader,
  MAXIMUM_PEARL_ABYSS_RESPONSE_BYTES,
  PearlAbyssInFlightCoordinator,
  PearlAbyssUpstreamError,
  type PearlAbyssHttpPort,
  type PearlAbyssLimiterPort,
  type PearlAbyssRequest,
  type PearlAbyssTimeoutPort,
} from "../../packages/pearl-abyss/src/server/index.ts";
import {
  dataTableStepArgument,
  noStepArguments,
  step,
  type ExecutableFeatureManifest,
  type StepDefinition,
} from "../support/manifest.ts";

interface RequestSafetyWorld {
  active?: number;
  errorCodes?: readonly string[];
  fetches?: number;
  gatewayBodyCancellations?: number;
  gatewayBodyResults?: readonly (string | null | undefined)[];
  gatewayResponseCancellations?: number;
  gatewayResponseResults?: readonly BoundedGatewayResponseBody[];
  maximumActive?: number;
  permits?: number;
  sharedCoordinatorAttempts?: number;
  pearlAbyssBodyCancellations?: number;
  release?: () => void;
  releaseOne?: () => void;
  results?: readonly unknown[];
  summaryAdmissions?: readonly MarketSummaryAdmission[];
  summaryTelemetry?: readonly MarketSummaryBudgetTelemetryEvent[];
  subrequestLimits?: readonly Readonly<Record<string, string>>[];
  expectedSubrequestLimits?: readonly Readonly<Record<string, string>>[];
}

const immediateTimeout: PearlAbyssTimeoutPort = {
  run: async (_timeoutMs, operation) => ({
    timedOut: false,
    value: await operation(new AbortController().signal),
  }),
};

const steps: readonly StepDefinition<RequestSafetyWorld>[] = [
  step(
    "two callers submit the same pending request to the shared Pearl Abyss coordinator",
    noStepArguments,
    async (world) => {
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      world.release = release;
      world.sharedCoordinatorAttempts = 0;
      const coordinator = new PearlAbyssInFlightCoordinator<string, string>(
        { maximumActiveRequests: 6, maximumQueuedRequests: 0 },
        {
          send: async (request) => {
            world.sharedCoordinatorAttempts = (world.sharedCoordinatorAttempts ?? 0) + 1;
            await gate;
            return request;
          },
        },
      );
      const first = coordinator.execute("same", "first");
      const second = coordinator.execute("same", "second");
      await waitFor(() => world.sharedCoordinatorAttempts === 1);
      release();
      world.results = [...(await Promise.all([first, second])), await coordinator.execute("same", "later")];
    },
  ),
  step("one execution satisfies both callers and a later request executes again", noStepArguments, (world) => {
    assert.equal(world.sharedCoordinatorAttempts, 2);
    assert.deepEqual(world.results, ["first", "first", "later"]);
  }),
  step("one Pearl Abyss request is denied and another limiter call fails", noStepArguments, async (world) => {
    world.fetches = 0;
    const http = countingHttp(world, async (request) => summaryResponse(request));
    const denied = createPearlAbyssMarketReader({
      http,
      timeout: immediateTimeout,
      limiter: { limit: async () => ({ success: false }) },
    });
    const failed = createPearlAbyssMarketReader({
      http,
      timeout: immediateTimeout,
      limiter: { limit: async () => Promise.reject(new Error("limiter unavailable")) },
    });
    world.errorCodes = await Promise.all([
      errorCode(denied.readSummaries(summaryInput(1))),
      errorCode(failed.readSummaries(summaryInput(2))),
    ]);
  }),
  step("each request fails as rate limited without a fetch or retry", noStepArguments, (world) => {
    assert.deepEqual(world.errorCodes, ["upstream/rate-limited", "upstream/rate-limited"]);
    assert.equal(world.fetches, 0);
  }),
  step("queued Pearl Abyss work competes with fresh work during a permit handoff", noStepArguments, async (world) => {
    let releaseOne = (): void => {};
    let releaseAll = (): void => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseOne = resolve;
    });
    const remainingGate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    world.release = releaseAll;
    world.releaseOne = releaseOne;
    world.active = 0;
    world.maximumActive = 0;
    world.fetches = 0;
    const reader = createPearlAbyssMarketReader({
      budget: new InvocationBudget(50),
      limiter: { limit: async () => ({ success: true }) },
      timeout: immediateTimeout,
      http: {
        fetch: async (request) => {
          world.fetches = (world.fetches ?? 0) + 1;
          world.active = (world.active ?? 0) + 1;
          world.maximumActive = Math.max(world.maximumActive ?? 0, world.active);
          await ((world.fetches ?? 0) === 1 ? firstGate : remainingGate);
          world.active -= 1;
          return summaryResponse(request);
        },
      },
    });
    const pending = Array.from({ length: 7 }, (_unused, index) => reader.readSummaries(summaryInput(index + 1)));
    await waitFor(() => world.maximumActive === 6);
    const fresh: ReturnType<typeof reader.readSummaries>[] = [];
    let nextItemId = 8;
    const submitFreshWork = (): void => {
      fresh.push(reader.readSummaries(summaryInput(nextItemId)));
      nextItemId += 1;
      if (nextItemId <= 24) queueMicrotask(submitFreshWork);
    };
    queueMicrotask(submitFreshWork);
    world.releaseOne();
    await waitFor(() => (world.fetches ?? 0) >= 7);
    await drainMicrotasks(30);
    pending.push(...fresh);
    world.results = pending;
  }),
  step("at most six outbound requests are active throughout the handoff", noStepArguments, async (world) => {
    assert.equal(world.maximumActive, 6);
    world.release?.();
    await Promise.all(world.results ?? []);
    assert.equal(world.maximumActive, 6);
  }),
  step("one Pearl Abyss subrequest remains in the invocation budget", noStepArguments, (world) => {
    world.permits = 0;
    world.fetches = 0;
  }),
  step("two distinct summary batches are requested sequentially", noStepArguments, async (world) => {
    const reader = createPearlAbyssMarketReader({
      budget: new InvocationBudget(1),
      limiter: countingLimiter(world),
      timeout: immediateTimeout,
      http: countingHttp(world, async (request) => summaryResponse(request)),
    });
    await reader.readSummaries(summaryInput(1));
    world.errorCodes = [await errorCode(reader.readSummaries(summaryInput(2)))];
  }),
  step("the second batch is rejected before a limiter call or fetch", noStepArguments, (world) => {
    assert.deepEqual(world.errorCodes, ["upstream/budget-exceeded"]);
    assert.equal(world.permits, 1);
    assert.equal(world.fetches, 1);
  }),
  step("one admitted Pearl Abyss fetch times out", noStepArguments, async (world) => {
    world.permits = 0;
    world.fetches = 0;
    const reader = createPearlAbyssMarketReader({
      limiter: countingLimiter(world),
      http: countingHttp(world, async (request) => summaryResponse(request)),
      timeout: {
        run: async (_timeoutMs, operation) => {
          await operation(new AbortController().signal);
          return { timedOut: true, settled: Promise.resolve() };
        },
      },
    });
    world.errorCodes = [await errorCode(reader.readSummaries(summaryInput(1)))];
  }),
  step("it fails with the typed timeout after one permit and one fetch", noStepArguments, (world) => {
    assert.deepEqual(world.errorCodes, ["upstream/timeout"]);
    assert.equal(world.permits, 1);
    assert.equal(world.fetches, 1);
  }),
  step(
    "Agris Proxy request streams without a trustworthy length exceed the byte ceiling",
    noStepArguments,
    async (world) => {
      world.gatewayBodyCancellations = 0;
      const request = (contentLength: string | null) => ({
        method: "POST",
        headers: new Headers(contentLength === null ? {} : { "Content-Length": contentLength }),
        body: observedOverLimitStream(MAXIMUM_GATEWAY_REQUEST_BYTES, () => {
          world.gatewayBodyCancellations = (world.gatewayBodyCancellations ?? 0) + 1;
        }),
      });
      world.gatewayBodyResults = await Promise.all([
        readBoundedGatewayRequestBody(request(null)),
        readBoundedGatewayRequestBody(request("1")),
      ]);
    },
  ),
  step("each Agris Proxy request is rejected and its stream is cancelled at the ceiling", noStepArguments, (world) => {
    assert.deepEqual(world.gatewayBodyResults, [undefined, undefined]);
    assert.equal(world.gatewayBodyCancellations, 2);
  }),
  step(
    "internal Agris Proxy response streams without a trustworthy length exceed the byte ceiling",
    noStepArguments,
    async (world) => {
      world.gatewayResponseCancellations = 0;
      const response = (contentLength: string | null) => ({
        headers: new Headers(contentLength === null ? {} : { "Content-Length": contentLength }),
        body: observedOverLimitStream(MAXIMUM_GATEWAY_RESPONSE_BYTES, () => {
          world.gatewayResponseCancellations = (world.gatewayResponseCancellations ?? 0) + 1;
        }),
      });
      world.gatewayResponseResults = await Promise.all([
        readBoundedGatewayResponseBody(response(null)),
        readBoundedGatewayResponseBody(response("1")),
      ]);
    },
  ),
  step(
    "each Agris Proxy response is classified as HTTP 502 too large and its stream is cancelled at the ceiling",
    noStepArguments,
    (world) => {
      assert.deepEqual(world.gatewayResponseResults, [
        { ok: false, code: "response-too-large", status: 502 },
        { ok: false, code: "response-too-large", status: 502 },
      ]);
      assert.equal(world.gatewayResponseCancellations, 2);
    },
  ),
  step(
    "a Pearl Abyss response stream with an understated length exceeds the byte ceiling",
    noStepArguments,
    async (world) => {
      world.pearlAbyssBodyCancellations = 0;
      const reader = createPearlAbyssMarketReader({
        limiter: { limit: async () => ({ success: true }) },
        timeout: immediateTimeout,
        http: {
          fetch: async () => ({
            status: 200,
            contentLength: "1",
            body: observedOverLimitStream(MAXIMUM_PEARL_ABYSS_RESPONSE_BYTES, () => {
              world.pearlAbyssBodyCancellations = (world.pearlAbyssBodyCancellations ?? 0) + 1;
            }),
          }),
        },
      });
      world.errorCodes = [await errorCode(reader.readSummaries(summaryInput(44_195)))];
    },
  ),
  step("the fetch fails as an invalid response and cancels the stream before decode", noStepArguments, (world) => {
    assert.deepEqual(world.errorCodes, ["upstream/invalid-response"]);
    assert.equal(world.pearlAbyssBodyCancellations, 1);
  }),
  step(
    "reordered duplicate summary keys race a seventh distinct key in one operation",
    noStepArguments,
    async (world) => {
      const telemetry: MarketSummaryBudgetTelemetryEvent[] = [];
      const reserve = marketSummaryReservation(
        new MarketSummaryOperationBudget(6, { record: (event) => telemetry.push(event) }),
      );
      const admissions = [
        await reserve({ region: "EU", locale: "EN", itemIds: [44_195, 10_006, 44_195] }),
        await reserve({ region: "EU", locale: "EN", itemIds: [10_006, 44_195] }),
      ];
      for (const region of ["NA", "ASIA", "MENA", "KR", "RU"] as const) {
        admissions.push(await reserve({ region, locale: "EN", itemIds: [10_006, 44_195] }));
      }
      admissions.push(
        ...(await Promise.all([
          reserve({ region: "EU", locale: "EN", itemIds: [44_195, 10_006, 10_006] }),
          reserve({ region: "JP", locale: "EN", itemIds: [10_006, 44_195] }),
        ])),
      );
      world.summaryAdmissions = admissions;
      world.summaryTelemetry = telemetry;
    },
  ),
  step("the duplicate reuses one of six admissions and the seventh is rejected", noStepArguments, (world) => {
    assert.deepEqual(world.summaryAdmissions, [
      { ok: true, reused: false },
      { ok: true, reused: true },
      { ok: true, reused: false },
      { ok: true, reused: false },
      { ok: true, reused: false },
      { ok: true, reused: false },
      { ok: true, reused: false },
      { ok: true, reused: true },
      { ok: false, code: "market-summary-budget/exceeded", limit: 6 },
    ]);
  }),
  step("summary admission telemetry contains aggregate outcomes only", noStepArguments, (world) => {
    assert.deepEqual(
      world.summaryTelemetry?.map((event) => event.outcome),
      ["admitted", "reused", "admitted", "admitted", "admitted", "admitted", "admitted", "reused", "rejected"],
    );
    for (const event of world.summaryTelemetry ?? []) {
      assert.deepEqual(Object.keys(event).sort(), ["admittedCount", "count", "event", "limit", "outcome"]);
      assert.equal(event.limit, 6);
      assert.equal(event.count, 1);
    }
  }),
  step("the subrequest limit is read from these bindings", dataTableStepArgument, (world, table) => {
    world.subrequestLimits = table.hashes.map((row) => {
      const binding = row.binding === "unset" ? undefined : row.binding;
      const budget = subrequestLimitFromBinding(binding);
      return {
        binding: row.binding ?? "",
        budget: String(budget),
        "summary batches": String(marketSummaryRequestLimitFor(budget)),
      };
    });
    world.expectedSubrequestLimits = table.hashes;
  }),
  step("each budget and summary batch limit is as listed", noStepArguments, (world) => {
    assert.deepEqual(world.subrequestLimits, world.expectedSubrequestLimits);
  }),
  step("a SUBREQUEST_LIMIT that is 0, negative, fractional or not a number is refused", noStepArguments, () => {
    for (const binding of ["0", "-1", "1.5", "many", 0, -1, 2.5]) {
      assert.throws(() => subrequestLimitFromBinding(binding), /SUBREQUEST_LIMIT/u, String(binding));
    }
  }),
  step("an invocation budget of 3 admits three subrequests and refuses the fourth", noStepArguments, () => {
    const budget = new InvocationBudget(subrequestLimitFromBinding("3"));
    assert.equal(budget.reserve(3).ok, true);
    assert.deepEqual(budget.reserve(1), {
      ok: false,
      code: "invocation-budget/exceeded",
      snapshot: { limit: 3, used: 3, remaining: 0 },
    });
  }),
];

export const centralMarketRequestSafetyFeature: ExecutableFeatureManifest<RequestSafetyWorld> = {
  id: "central-market-request-safety",
  uri: "tests/features/request-safety.feature",
  createWorld: () => ({}),
  steps,
};

function countingLimiter(world: RequestSafetyWorld): PearlAbyssLimiterPort {
  return {
    limit: async () => {
      world.permits = (world.permits ?? 0) + 1;
      return { success: true };
    },
  };
}

function countingHttp(
  world: RequestSafetyWorld,
  fetch: (request: PearlAbyssRequest) => Promise<{
    readonly body: ReadableStream<Uint8Array>;
    readonly contentLength: string | null;
    readonly status: number;
  }>,
): PearlAbyssHttpPort {
  return {
    fetch: async (request) => {
      world.fetches = (world.fetches ?? 0) + 1;
      return fetch(request);
    },
  };
}

function summaryInput(itemId: number) {
  return { region: "EU" as const, locale: "EN" as const, itemIds: [itemId] };
}

function summaryResponse(request: PearlAbyssRequest) {
  if (request.capability !== "summaries") throw new TypeError("Expected a summary request");
  const payload = request.itemIds.map((itemId) => `${itemId}-1-2-3`).join("|");
  const bytes = new TextEncoder().encode(JSON.stringify({ resultCode: 0, resultMsg: payload }));
  return {
    status: 200,
    body: streamFromBytes(bytes),
    contentLength: String(bytes.byteLength),
  };
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start: (controller) => {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function observedOverLimitStream(maximumBytes: number, onCancel: () => void): ReadableStream<Uint8Array> {
  let emission = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull: (controller) => {
        if (emission === 0) {
          controller.enqueue(new Uint8Array(maximumBytes));
        } else if (emission === 1) {
          controller.enqueue(new Uint8Array(1));
        } else {
          controller.close();
        }
        emission += 1;
      },
      cancel: () => {
        onCancel();
        return Promise.reject(new Error("fixture cancellation failed"));
      },
    },
    { highWaterMark: 0 },
  );
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "none";
  } catch (error: unknown) {
    return error instanceof PearlAbyssUpstreamError ? error.code : "unexpected";
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for request-safety fixture state");
}

async function drainMicrotasks(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}
