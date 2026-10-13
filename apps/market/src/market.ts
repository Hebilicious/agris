import {
  createPearlAbyssMarketReader,
  PearlAbyssInFlightCoordinator,
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
const PEARL_ABYSS_RATE_LIMIT_KEY = "central-market-pearl-abyss";
const PEARL_ABYSS_REQUEST_TIMEOUT_MS = 30_000;
const PEARL_ABYSS_FAILURE_HEADER = "X-Pearl-Abyss-Failure";

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
} as const satisfies Record<PearlAbyssRegion, DurableObjectLocationHint>;

export const COORDINATOR_LOCATION_BY_HOST: ReadonlyMap<string, DurableObjectLocationHint> = new Map(
  PEARL_ABYSS_REGIONS.map((region) => [region.host, PEARL_ABYSS_COORDINATOR_LOCATIONS[region.code]]),
);

/** The coordinator that serves one Pearl Abyss host: its object name, and where to create it. */
export interface PearlAbyssCoordinatorAddress {
  readonly name: string;
  readonly locationHint: DurableObjectLocationHint;
}

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
  "upstream/invalid-response" | "upstream/rate-limited"
>;

type BufferedPearlAbyssResponse =
  | { readonly kind: "failure"; readonly code: CoordinatedPearlAbyssFailureCode; readonly status: 429 | 502 }
  | { readonly kind: "response"; readonly body: Uint8Array | null; readonly status: number };

/** The burst backstop the coordinator consults before each distinct upstream request. */
export interface PearlAbyssRateLimiter {
  limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

/** One coordinator instance, which the market reaches by the upstream host it serves. */
export interface PearlAbyssCoordinatorPort {
  execute(request: Request): Promise<Response>;
}

/** A concurrency ceiling high enough never to be reached: what `0` or no setting means. */
const UNLIMITED_CONCURRENT_REQUESTS = Number.MAX_SAFE_INTEGER;

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
 * once. Absent or `0` sets no limit; anything but a non-negative whole number, as a JSON number or text, throws.
 */
export function maximumConcurrentRequestsFromBinding(value: unknown): number {
  if (value === undefined) return UNLIMITED_CONCURRENT_REQUESTS;
  const decoded = decodeConcurrency(value);
  if (Exit.isFailure(decoded)) {
    throw new RangeError("PA_MAX_CONCURRENT_REQUESTS must be a non-negative whole number, 0 for no limit");
  }
  return decoded.value === 0 ? UNLIMITED_CONCURRENT_REQUESTS : decoded.value;
}

/**
 * The work one coordinator instance does: admit each distinct upstream request once, within `maximumConcurrentRequests`,
 * and share its buffered answer with every matching request in flight. Without a limiter, nothing caps the rate.
 */
export class PearlAbyssCoordination implements PearlAbyssCoordinatorPort {
  private readonly requests: PearlAbyssInFlightCoordinator<Request, BufferedPearlAbyssResponse>;
  private readonly limiter: PearlAbyssRateLimiter | undefined;

  public constructor(maximumConcurrentRequests: number, limiter: PearlAbyssRateLimiter | undefined) {
    this.limiter = limiter;
    this.requests = new PearlAbyssInFlightCoordinator(maximumConcurrentRequests, (request) =>
      this.fetchDistinct(request),
    );
  }

  public async execute(request: Request): Promise<Response> {
    const key = `${request.url}\n${await request.clone().text()}`;
    const response = await this.requests.execute(key, request);
    if (response.kind === "failure") {
      return new Response(null, {
        status: response.status,
        headers: { [PEARL_ABYSS_FAILURE_HEADER]: response.code },
      });
    }
    const body = response.body === null ? null : response.body.slice();
    return new Response(body, {
      status: response.status,
      headers: body === null ? undefined : { "Content-Length": String(body.byteLength) },
    });
  }

  private async fetchDistinct(request: Request): Promise<BufferedPearlAbyssResponse> {
    if (this.limiter !== undefined) {
      let permit: { readonly success: boolean };
      try {
        permit = await this.limiter.limit({ key: PEARL_ABYSS_RATE_LIMIT_KEY });
      } catch {
        return { kind: "failure", code: "upstream/rate-limited", status: 429 };
      }
      if (!permit.success) return { kind: "failure", code: "upstream/rate-limited", status: 429 };
    }

    const response = await fetch(request);
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
    return new Response(response.body, {
      status: availability.getSnapshot().matches("totalUnavailable") ? 503 : response.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": response.headers.get("content-type") ?? "application/graphql-response+json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
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
    case "upstream/rate-limited":
      return new PearlAbyssUpstreamError(value, "Pearl Abyss request rate limited");
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
