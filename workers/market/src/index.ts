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
  marketSummaryReservation,
  type InvocationBudgetReservation,
  type MarketSummaryReservation,
} from "@agris/invocation-budget";
import { createWorkerTimeoutPort } from "@agris/worker-runtime";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createActor } from "xstate";

import type { MarketEnv } from "./env.js";
export type { MarketEnv } from "./env.js";
import {
  pearlAbyssExecutionAvailabilityMachine,
  settlementEvents,
} from "./pearl-abyss-execution-availability-machine.js";

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
const PEARL_ABYSS_COORDINATOR_LOCATIONS = {
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

const COORDINATOR_LOCATION_BY_HOST: ReadonlyMap<string, DurableObjectLocationHint> = new Map(
  PEARL_ABYSS_REGIONS.map((region) => [region.host, PEARL_ABYSS_COORDINATOR_LOCATIONS[region.code]]),
);

function pearlAbyssCoordinator(env: MarketEnv, hostname: string): DurableObjectStub<PearlAbyssCoordinator> {
  const locationHint = COORDINATOR_LOCATION_BY_HOST.get(hostname);
  if (locationHint === undefined) throw new Error(`No Pearl Abyss region serves ${hostname}`);
  return env.PA_COORDINATOR.getByName(`${locationHint}:${hostname}`, { locationHint });
}

type CoordinatedPearlAbyssFailureCode = Extract<
  PearlAbyssUpstreamErrorCode,
  "upstream/invalid-response" | "upstream/rate-limited"
>;

type BufferedPearlAbyssResponse =
  | { readonly kind: "failure"; readonly code: CoordinatedPearlAbyssFailureCode; readonly status: 429 | 502 }
  | { readonly kind: "response"; readonly body: Uint8Array | null; readonly status: number };

export class BudgetedMarketSubgraph extends WorkerEntrypoint<MarketEnv> {
  public fetch(request: Request): Promise<Response> {
    return executeMarketSubgraph(
      request,
      this.env,
      invocationBudgetReservation(new InvocationBudget()),
      marketSummaryReservation(new MarketSummaryOperationBudget()),
    );
  }

  public fetchWithBudget(
    request: Request,
    reserveBudget: InvocationBudgetReservation,
    reserveMarketSummary: MarketSummaryReservation,
  ): Promise<Response> {
    return executeMarketSubgraph(request, this.env, reserveBudget, reserveMarketSummary);
  }
}

export class PearlAbyssCoordinator extends DurableObject<MarketEnv> {
  private readonly requests: PearlAbyssInFlightCoordinator<Request, BufferedPearlAbyssResponse>;

  public constructor(state: DurableObjectState, env: MarketEnv) {
    super(state, env);
    this.requests = new PearlAbyssInFlightCoordinator(
      requireMaximumConcurrentRequests(env.PA_MAX_CONCURRENT_REQUESTS),
      (request) => this.fetchDistinct(request),
    );
  }

  public async fetch(request: Request): Promise<Response> {
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
    let permit: { readonly success: boolean };
    try {
      permit = await this.env.PA_RATE_LIMITER.limit({ key: PEARL_ABYSS_RATE_LIMIT_KEY });
    } catch {
      return { kind: "failure", code: "upstream/rate-limited", status: 429 };
    }
    if (!permit.success) return { kind: "failure", code: "upstream/rate-limited", status: 429 };

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

export const marketWorker = {
  fetch(request: Request, env: MarketEnv): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/_internal/ready") {
      return Promise.resolve(new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }));
    }
    return executeMarketSubgraph(
      request,
      env,
      invocationBudgetReservation(new InvocationBudget()),
      marketSummaryReservation(new MarketSummaryOperationBudget()),
    );
  },
} satisfies ExportedHandler<MarketEnv>;

export default marketWorker;

async function executeMarketSubgraph(
  request: Request,
  env: MarketEnv,
  reserveBudget: InvocationBudgetReservation,
  reserveMarketSummary: MarketSummaryReservation,
): Promise<Response> {
  const availability = createActor(pearlAbyssExecutionAvailabilityMachine).start();
  try {
    const response = await marketSubgraph.fetch(request, {
      reader: createPearlAbyssMarketReader({
        reserveBudget,
        reserveMarketSummary,
        http: pearlAbyssHttpPort(env),
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

function pearlAbyssHttpPort(env: MarketEnv): PearlAbyssHttpPort {
  return {
    fetch: async (request, signal) => {
      const hostname = new URL(request.url).hostname;
      const coordinator = pearlAbyssCoordinator(env, hostname);
      const response = await coordinator.fetch(new Request(request.url, pearlAbyssRequestInit(request, signal)));
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

function requireMaximumConcurrentRequests(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("PA_MAX_CONCURRENT_REQUESTS must be a positive safe integer");
  }
  return value;
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
