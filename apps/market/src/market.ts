import {
  createPearlAbyssMarketReader,
  PEARL_ABYSS_THROTTLE_RETRY_AFTER_SECONDS,
  PearlAbyssCoordinatorDeadlineError,
  PearlAbyssCoordinatorQueueFullError,
  PearlAbyssInFlightCoordinator,
  pearlAbyssRequestKey,
  PearlAbyssUpstreamError,
  readPearlAbyssResponseBody,
  type PearlAbyssHttpPort,
  type PearlAbyssRequest,
  type PearlAbyssUpstreamErrorCode,
} from "@agris/pearl-abyss/server";
import { PEARL_ABYSS_REGIONS, type PearlAbyssRegion } from "@agris/pearl-abyss/regions";
import { createMarketSubgraph } from "@agris/market-subgraph";
import {
  InvocationBudget,
  invocationBudgetReservation,
  MarketSummaryOperationBudget,
  marketSummaryRequestLimitFor,
  marketSummaryReservation,
  subrequestLimitFromBinding,
  type InvocationBudgetReservation,
  type MarketSummaryReservation,
} from "@agris/invocation-budget";
import { createWorkerTimeoutPort } from "@agris/worker-runtime";
import { Exit, Schema, SchemaTransformation } from "effect";
import { createActor } from "xstate";

import {
  pearlAbyssExecutionAvailabilityMachine,
  settlementEvents,
} from "./pearl-abyss-execution-availability-machine.js";

/**
 * The market subgraph and its Pearl Abyss coordination, independent of how a Worker hosts them.
 *
 * The Worker's own entrypoints in `index.ts` and the Alchemy market Worker under `infra/` both serve through this
 * module. It imports nothing from the Workers runtime, so a deploy tool can load it; the hosts differ only in how they
 * reach the coordinator and the rate limiter.
 */

const marketSubgraph = createMarketSubgraph();
const PEARL_ABYSS_FAILURE_HEADER = "X-Pearl-Abyss-Failure";

/**
 * How long a Pearl Abyss request may take. The market gives up on a read after it; a coordinator gives each distinct
 * request the same from its arrival, its permit, its wait for a slot and its send included, and drops it after that.
 */
export const PEARL_ABYSS_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long a coordinator waits for a permit from its region's rate limit. A permit that has not come by then is a
 * refusal: a stalled rate limiter cannot hold the coordinator's queue.
 */
export const PEARL_ABYSS_PERMIT_TIMEOUT_MS = 5_000;

/**
 * Where each region's coordinator runs, so its calls to Pearl Abyss start next to the server that answers them.
 *
 * Every host sits behind Imperva's anycast edge, so DNS does not reveal where a server is. These hints come from timing
 * `GetWorldMarketHotList` against every host from a Durable Object at each hint on 2026-10-02; each region takes the
 * hint of the area that answered fastest. The European servers answered fastest from London and Paris, which `weur`
 * covers; `afr` also placed its object in Paris only because Cloudflare has no Durable Object location in Africa, so it
 * is not used for them. Cloudflare has no location in South America either, and `enam` measured closest to it. A hint
 * applies only when an object is created, so the coordinator's name carries its hint: changing one here creates a
 * coordinator at the new location rather than leaving the old one where it was.
 */
/** The Durable Object location hints the coordinators use, each one a `DurableObjectLocationHint`. */
export type PearlAbyssCoordinatorLocation = "apac" | "enam" | "weur" | "wnam";

export const PEARL_ABYSS_COORDINATOR_LOCATIONS = {
  EU: "weur",
  NA: "wnam",
  ASIA: "apac",
  MENA: "weur",
  KR: "apac",
  RU: "weur",
  JP: "apac",
  TW: "apac",
  SA: "enam",
  CONSOLE_EU: "weur",
  CONSOLE_NA: "wnam",
  CONSOLE_ASIA: "apac",
} as const satisfies Record<PearlAbyssRegion, PearlAbyssCoordinatorLocation>;

export const COORDINATOR_LOCATION_BY_HOST: ReadonlyMap<string, PearlAbyssCoordinatorLocation> = new Map(
  PEARL_ABYSS_REGIONS.map((region) => [region.host, PEARL_ABYSS_COORDINATOR_LOCATIONS[region.code]]),
);

/** The coordinator that serves one Pearl Abyss host: its object name, and where to create it. */
export interface PearlAbyssCoordinatorAddress {
  readonly name: string;
  readonly locationHint: PearlAbyssCoordinatorLocation;
}

/**
 * The `PA_RATE_LIMITER` key for one Pearl Abyss host. Each region is its own Pearl Abyss server, so each has its own
 * rate limit: the key names the host, and regions whose coordinators share a Cloudflare location (EU, MENA and RU in
 * `weur`, for one) still never share a count.
 *
 * Workers rate limits count per Cloudflare location. A region has exactly one coordinator, created at its location
 * hint, and only that coordinator consults its key, so the per-location count is in effect one exact count per region.
 */
export function pearlAbyssRateLimitKey(hostname: string): string {
  return `central-market-pearl-abyss:${hostname}`;
}

/**
 * Distinct Pearl Abyss requests one coordinator lets wait, for a rate permit or for an active slot, beyond the
 * `PA_MAX_CONCURRENT_REQUESTS` it runs. Past it a distinct request fails at once as `upstream/queue-full`, so a flood
 * of distinct reads cannot hold the coordinator's memory: a hundred waiting request bodies are a few megabytes at most.
 * It is five minutes of the demo's rate limit for one region, more than a caller waits.
 */
export const MAXIMUM_QUEUED_PEARL_ABYSS_REQUESTS = 100;

/**
 * The distinct Pearl Abyss requests one coordinator runs at once when `PA_MAX_CONCURRENT_REQUESTS` is `0` or unset,
 * which set no concurrency limit of their own. It keeps the work a coordinator holds finite, with up to
 * `MAXIMUM_QUEUED_PEARL_ABYSS_REQUESTS` more waiting, and is far above the 300 requests the default rate limit admits
 * one region in 30 seconds.
 */
export const UNLIMITED_CONCURRENT_PEARL_ABYSS_REQUESTS = 1_000;

/**
 * Address the coordinator for one Pearl Abyss host: `getByName(address.name, { locationHint: address.locationHint })`.
 * Every host the market reaches belongs to a known region.
 */
export function pearlAbyssCoordinatorAddress(hostname: string): PearlAbyssCoordinatorAddress {
  const locationHint = COORDINATOR_LOCATION_BY_HOST.get(hostname);
  if (locationHint === undefined) throw new Error(`No Pearl Abyss region serves ${hostname}`);
  return { name: `${locationHint}:${hostname}`, locationHint };
}

type CoordinatedPearlAbyssFailureCode = Extract<
  PearlAbyssUpstreamErrorCode,
  "upstream/invalid-response" | "upstream/queue-full" | "upstream/rate-limited" | "upstream/timeout"
>;

type BufferedPearlAbyssResponse =
  | { readonly kind: "failure"; readonly code: CoordinatedPearlAbyssFailureCode; readonly status: 429 | 502 | 504 }
  | { readonly kind: "response"; readonly body: Uint8Array | null; readonly status: number };

const RATE_LIMITED: BufferedPearlAbyssResponse = { kind: "failure", code: "upstream/rate-limited", status: 429 };
const QUEUE_FULL: BufferedPearlAbyssResponse = { kind: "failure", code: "upstream/queue-full", status: 429 };
const TIMED_OUT: BufferedPearlAbyssResponse = { kind: "failure", code: "upstream/timeout", status: 504 };

/** The burst backstop the coordinator consults before each distinct upstream request. */
export interface PearlAbyssRateLimiter {
  limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

/** One coordinator instance, which the market reaches by the upstream host it serves. */
export interface PearlAbyssCoordinatorPort {
  execute(request: Request): Promise<Response>;
}

const decodeConcurrency = Schema.decodeUnknownExit(
  Schema.Union([
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u)).pipe(
      Schema.decodeTo(Schema.Int, SchemaTransformation.numberFromString),
    ),
  ]),
);

/**
 * BOUNDARY: The `PA_MAX_CONCURRENT_REQUESTS` binding: how many distinct Pearl Abyss requests one coordinator runs at
 * once. Absent or `0` sets no limit of its own, which runs up to `UNLIMITED_CONCURRENT_PEARL_ABYSS_REQUESTS`; anything
 * but a non-negative whole number, as a JSON number or text, throws.
 */
export function maximumConcurrentRequestsFromBinding(value: unknown): number {
  if (value === undefined) return UNLIMITED_CONCURRENT_PEARL_ABYSS_REQUESTS;
  const decoded = decodeConcurrency(value);
  if (Exit.isFailure(decoded) || !Number.isSafeInteger(decoded.value)) {
    throw new RangeError("PA_MAX_CONCURRENT_REQUESTS must be a non-negative whole number, 0 for no limit");
  }
  return decoded.value === 0 ? UNLIMITED_CONCURRENT_PEARL_ABYSS_REQUESTS : decoded.value;
}

/** The time a coordinator reads; the runtime's own unless a test supplies one. */
export interface PearlAbyssCoordinatorClock {
  /** Milliseconds since the epoch, as `Date.now()`. */
  now(): number;
  /** A signal that aborts `milliseconds` from now, as `AbortSignal.timeout`. */
  timeout(milliseconds: number): AbortSignal;
}

const RUNTIME_CLOCK: PearlAbyssCoordinatorClock = {
  now: () => Date.now(),
  timeout: (milliseconds) => AbortSignal.timeout(milliseconds),
};

/** What a coordinator needs from its host: the market Worker's bindings, and how it reaches Pearl Abyss. */
export interface PearlAbyssCoordinatorOptions {
  /** `PA_MAX_CONCURRENT_REQUESTS`, as `maximumConcurrentRequestsFromBinding` reads it. */
  readonly maximumConcurrentRequests: number;
  /** The `PA_RATE_LIMITER` binding, which the coordinator consults for its own host; absent limits no rate. */
  readonly limiter: PearlAbyssRateLimiter | undefined;
  /** How the coordinator reaches Pearl Abyss; the runtime's `fetch` unless a test supplies one. */
  readonly upstream?: ((request: Request) => Promise<Response>) | undefined;
  /** The time the coordinator reads; the runtime's clock unless a test supplies one. */
  readonly clock?: PearlAbyssCoordinatorClock | undefined;
}

/** Asks for one permit before a distinct request may wait for a slot; `false` refuses it. */
type PearlAbyssPermit = (request: DistinctPearlAbyssRequest, signal: AbortSignal) => Promise<boolean>;

/**
 * Permits from `PA_RATE_LIMITER`, counted for the request's own Pearl Abyss host (`pearlAbyssRateLimitKey`). The binding
 * is local to the coordinator's Cloudflare location, so a permit costs no round trip. One not granted within
 * `PEARL_ABYSS_PERMIT_TIMEOUT_MS`, or before every caller of its request gave up, is refused.
 */
function regionRateLimit(limiter: PearlAbyssRateLimiter, clock: PearlAbyssCoordinatorClock): PearlAbyssPermit {
  return async (request, signal) => {
    const outcome = await untilAborted(
      limiter.limit({ key: pearlAbyssRateLimitKey(new URL(request.url).hostname) }),
      AbortSignal.any([signal, clock.timeout(PEARL_ABYSS_PERMIT_TIMEOUT_MS)]),
    );
    return outcome.success;
  };
}

/** `pending`, or its signal's reason once `signal` aborts first, whether or not `pending` itself honours the signal. */
function untilAborted<Value>(pending: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** A distinct Pearl Abyss request as the coordinator holds it: read once, with no caller's signal attached. */
interface DistinctPearlAbyssRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

/** A request read for the coordinator: the key it is shared by, and its distinct form. */
interface KeyedPearlAbyssRequest {
  readonly key: string;
  readonly request: DistinctPearlAbyssRequest;
}

async function keyedPearlAbyssRequest(request: Request): Promise<KeyedPearlAbyssRequest> {
  const body = await request.text();
  return {
    key: await pearlAbyssRequestKey(request.url, body),
    request: { url: request.url, method: request.method, headers: new Headers(request.headers), body },
  };
}

/**
 * The `PearlAbyssCoordinator` Durable Object's work, whichever host runs it: send each distinct upstream request once,
 * within `maximumConcurrentRequests`, and share its buffered answer with every matching request in flight.
 *
 * Each distinct request asks its region's rate limit for a permit before it waits for an active slot, so a refused one
 * never queues, and at most `MAXIMUM_QUEUED_PEARL_ABYSS_REQUESTS` wait beyond the active ones. Each has
 * `PEARL_ABYSS_REQUEST_TIMEOUT_MS` from its arrival, its permit and its wait included: past it, it leaves the queue or
 * its upstream call is cancelled, and it fails as `upstream/timeout`. A caller that gives up stops only its own wait;
 * the request leaves the queue, or its upstream call is cancelled, once every caller sharing it has given up. Without a
 * limiter, nothing caps the rate.
 */
export class PearlAbyssCoordinatorObject implements PearlAbyssCoordinatorPort {
  private readonly requests: PearlAbyssInFlightCoordinator<DistinctPearlAbyssRequest, BufferedPearlAbyssResponse>;
  private readonly permit: PearlAbyssPermit | undefined;
  private readonly upstream: (request: Request) => Promise<Response>;

  public constructor(options: PearlAbyssCoordinatorOptions) {
    const clock = options.clock ?? RUNTIME_CLOCK;
    this.permit = options.limiter === undefined ? undefined : regionRateLimit(options.limiter, clock);
    this.upstream = options.upstream ?? ((request) => fetch(request));
    this.requests = new PearlAbyssInFlightCoordinator(
      {
        maximumActiveRequests: options.maximumConcurrentRequests,
        maximumQueuedRequests: MAXIMUM_QUEUED_PEARL_ABYSS_REQUESTS,
      },
      {
        admit: (request, signal) => this.admit(request, signal),
        send: (request, signal) => this.send(request, signal),
        deadline: () => clock.timeout(PEARL_ABYSS_REQUEST_TIMEOUT_MS),
      },
    );
  }

  public execute(request: Request): Promise<Response> {
    return this.share(request).then(coordinatorResponse, (error: unknown) => {
      if (error instanceof PearlAbyssCoordinatorQueueFullError) return coordinatorResponse(QUEUE_FULL);
      if (error instanceof PearlAbyssCoordinatorDeadlineError) return coordinatorResponse(TIMED_OUT);
      throw error;
    });
  }

  /**
   * Hands the read request to the in-flight coordinator and returns at once, so this frame keeps neither the request
   * nor its body while the answer is pending: only the first caller of a key leaves its body with the coordinator.
   */
  private async share(request: Request): Promise<BufferedPearlAbyssResponse> {
    const signal = request.signal;
    const keyed = await keyedPearlAbyssRequest(request);
    return this.requests.execute(keyed.key, keyed.request, signal);
  }

  private async admit(
    request: DistinctPearlAbyssRequest,
    signal: AbortSignal,
  ): Promise<BufferedPearlAbyssResponse | undefined> {
    if (this.permit === undefined) return undefined;
    try {
      return (await this.permit(request, signal)) ? undefined : RATE_LIMITED;
    } catch {
      return RATE_LIMITED;
    }
  }

  private async send(request: DistinctPearlAbyssRequest, signal: AbortSignal): Promise<BufferedPearlAbyssResponse> {
    const response = await this.upstream(
      new Request(request.url, { method: request.method, headers: request.headers, body: request.body, signal }),
    );
    if (response.status < 200 || response.status >= 300) {
      await cancelResponseBody(response.body);
      return { kind: "response", status: response.status, body: null };
    }
    try {
      return {
        kind: "response",
        status: response.status,
        body: await readPearlAbyssResponseBody({
          status: response.status,
          body: response.body,
          contentLength: response.headers.get("content-length"),
        }),
      };
    } catch (error: unknown) {
      if (error instanceof PearlAbyssUpstreamError && error.code === "upstream/invalid-response") {
        return { kind: "failure", code: error.code, status: 502 };
      }
      throw error;
    }
  }
}

/** The coordinator's answer to one caller: its own copy of the shared body, or a failure the market reads back. */
function coordinatorResponse(response: BufferedPearlAbyssResponse): Response {
  if (response.kind === "failure") {
    return new Response(null, { status: response.status, headers: { [PEARL_ABYSS_FAILURE_HEADER]: response.code } });
  }
  const body = response.body === null ? null : response.body.slice();
  return new Response(body, {
    status: response.status,
    headers: body === null ? {} : { "Content-Length": String(body.byteLength) },
  });
}

/** The answer to the local runtimes' readiness probe, or `null` for every other request. */
export function readinessResponse(request: Request): Response | null {
  if (request.method === "GET" && new URL(request.url).pathname === "/_internal/ready") {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  return null;
}

/** The reservations a request that arrives without the gateway's budget spends: its own, within `SUBREQUEST_LIMIT`. */
export interface StandaloneBudget {
  readonly reserveBudget: InvocationBudgetReservation;
  readonly reserveMarketSummary: MarketSummaryReservation;
}

/** BOUNDARY: A fresh budget for one request, from the Worker's `SUBREQUEST_LIMIT` binding (absent is 50). */
export function standaloneBudget(subrequestLimitBinding: unknown): StandaloneBudget {
  const subrequestLimit = subrequestLimitFromBinding(subrequestLimitBinding);
  return {
    reserveBudget: invocationBudgetReservation(new InvocationBudget(subrequestLimit)),
    reserveMarketSummary: marketSummaryReservation(
      new MarketSummaryOperationBudget(marketSummaryRequestLimitFor(subrequestLimit)),
    ),
  };
}

/** Answer one market subgraph request, reaching Pearl Abyss through the coordinator `coordinatorFor` names per host. */
export async function executeMarketSubgraph(
  request: Request,
  coordinatorFor: (hostname: string) => PearlAbyssCoordinatorPort,
  reserveBudget: InvocationBudgetReservation,
  reserveMarketSummary: MarketSummaryReservation,
): Promise<Response> {
  const availability = createActor(pearlAbyssExecutionAvailabilityMachine).start();
  try {
    const response = await marketSubgraph.fetch(request, {
      reader: createPearlAbyssMarketReader({
        reserveBudget,
        reserveMarketSummary,
        http: pearlAbyssHttpPort(coordinatorFor),
        // The Durable Object admits each distinct upstream request once.
        limiter: { limit: async () => ({ success: true }) },
        onRequestSettled: (outcome) => availability.send(settlementEvents[outcome]),
        timeout: createWorkerTimeoutPort(),
        timeoutMs: PEARL_ABYSS_REQUEST_TIMEOUT_MS,
      }),
      clock: { nowIso: () => new Date().toISOString() },
    });
    const outcome = availability.getSnapshot();
    const throttled = outcome.matches("throttled");
    return new Response(response.body, {
      // Nothing was read: 429 when a limiter refused the reads, 503 when Pearl Abyss could not be reached.
      status: throttled ? 429 : outcome.matches("totalUnavailable") ? 503 : response.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": response.headers.get("content-type") ?? "application/graphql-response+json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        ...(throttled ? { "Retry-After": String(PEARL_ABYSS_THROTTLE_RETRY_AFTER_SECONDS) } : {}),
      },
    });
  } finally {
    availability.stop();
  }
}

function pearlAbyssHttpPort(coordinatorFor: (hostname: string) => PearlAbyssCoordinatorPort): PearlAbyssHttpPort {
  return {
    fetch: async (request, signal) => {
      const coordinator = coordinatorFor(new URL(request.url).hostname);
      const response = await coordinator.execute(new Request(request.url, pearlAbyssRequestInit(request, signal)));
      const failure = coordinatorFailure(response.headers.get(PEARL_ABYSS_FAILURE_HEADER));
      if (failure !== null) {
        await cancelResponseBody(response.body);
        throw failure;
      }
      return {
        status: response.status,
        body: response.body,
        contentLength: response.headers.get("content-length"),
      };
    },
  };
}

function coordinatorFailure(value: string | null): PearlAbyssUpstreamError | null {
  switch (value) {
    case "upstream/invalid-response":
      return new PearlAbyssUpstreamError(value, "Pearl Abyss coordinator rejected an invalid response");
    case "upstream/queue-full":
      return new PearlAbyssUpstreamError(value, "Pearl Abyss coordinator queue is full");
    case "upstream/rate-limited":
      return new PearlAbyssUpstreamError(value, "Pearl Abyss request rate limited");
    case "upstream/timeout":
      return new PearlAbyssUpstreamError(value, "Pearl Abyss request timed out in the coordinator");
    default:
      return null;
  }
}

async function cancelResponseBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Cancellation is cleanup; rejection must not replace the upstream status.
  }
}

function pearlAbyssRequestInit(request: PearlAbyssRequest, signal: AbortSignal): RequestInit {
  return {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal,
  };
}
