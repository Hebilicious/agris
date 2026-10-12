// A host that bundles this module type-checks it without this project's tsconfig; the reference carries the
// `*.graphql` text-module declaration along.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./modules.d.ts" />

import {
  classifyGatewayResponse,
  createGatewayRequestProtocol,
  dispatchGatewayOperation,
  readBoundedGatewayRequestBody,
  readBoundedGatewayResponseBody,
  ServiceBindingCoordinator,
  ServiceBindingFailure,
  type ServiceBindingPort,
  type GatewayCachePolicy,
  type GatewayCacheStatus,
  type JsonObject,
  type NormalizedGatewayRequest,
} from "@agris/core";
import { createWorkerTimeoutPort } from "@agris/worker-runtime";
import {
  InvocationBudget,
  invocationBudgetReservation,
  MarketSummaryOperationBudget,
  marketSummaryReservation,
  type InvocationBudgetReservation,
  type MarketSummaryReservation,
} from "@agris/invocation-budget";
import { createGatewayRuntime, useCustomFetch } from "@graphql-hive/gateway-runtime";
import httpTransport from "@graphql-mesh/transport-http";
import { buildSchema } from "graphql";
import { WorkerEntrypoint } from "cloudflare:workers";

import type { GatewayEnv, SmokeGatewayEnv } from "./env.js";
export type { GatewayEnv, LocalGatewayEnv, SmokeGatewayEnv } from "./env.js";

import clientSchemaSdl from "../../../tools/graph/artifacts/client-schema.graphql";
import supergraphSdl from "../../../tools/graph/artifacts/supergraph.graphql";

const MARKET_SUBGRAPH_URL = "https://central-market-market.internal/graphql";
const CATALOG_SUBGRAPH_URL = "https://central-market-catalog.internal/graphql";
const GRAPHQL_PATH = "/graphql";
const SUBGRAPH_TIMEOUT_MS = 35_000;
const CACHE_WRITE_EPOCH_HEADER = "x-central-market-cache-write-epoch-ms";

export interface AgrisProxyRuntimeEnv {
  readonly CATALOG: ServiceBindingPort;
  readonly MARKET: ServiceBindingPort;
  readonly CACHE_SMOKE_MODE?: "enabled";
  readonly LOCAL_INLINE_CATALOG?: true;
}

export interface BudgetedSubgraphServiceBinding {
  fetchWithBudget(
    request: Request,
    reserveBudget: InvocationBudgetReservation,
    reserveMarketSummary: MarketSummaryReservation,
  ): Promise<Response>;
}

type DeployedAgrisProxyEnv = GatewayEnv | SmokeGatewayEnv;

/** The client schema every caller's documents are validated against. */
export const clientSchema = buildSchema(clientSchemaSdl);
const protocol = createGatewayRequestProtocol({ schema: clientSchema });

export interface AgrisProxyExecutionProps {
  readonly cachePolicy: GatewayCachePolicy;
  readonly document: string;
  readonly operationName: string | null;
  readonly variables: JsonObject;
  readonly smokeFailureAfterEpochMs: number | null;
}

export class CachedAgrisProxy extends WorkerEntrypoint<DeployedAgrisProxyEnv, AgrisProxyExecutionProps> {
  public async fetch(_request: Request): Promise<Response> {
    return executeAgrisProxy(deployedRuntime(this.env), this.ctx.props);
  }
}

export const agrisProxyWorker = {
  async fetch(request: Request, env: AgrisProxyRuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== GRAPHQL_PATH) return gatewayError(404, "Not found");

    const bodyText = await readBoundedGatewayRequestBody(request);
    if (bodyText === undefined) return gatewayError(400, "GraphQL request body exceeds the accepted size");
    const normalized = await protocol.normalize({
      method: request.method,
      contentType: request.headers.get("content-type"),
      searchParams: requestUrl.search.slice(1),
      bodyText,
    });
    if (!normalized.ok) return gatewayError(normalized.error.status, normalized.error.message);
    return serveGatewayOperation(normalized.value, env, ctx);
  },
} satisfies ExportedHandler<AgrisProxyRuntimeEnv>;

/**
 * Serve one normalized operation: through the cache-enabled `CachedAgrisProxy` entrypoint when its policy stores it,
 * otherwise directly. The main module of the Worker that calls this must export `CachedAgrisProxy`.
 */
export async function serveGatewayOperation(
  normalized: NormalizedGatewayRequest,
  env: AgrisProxyRuntimeEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const props: AgrisProxyExecutionProps = {
    cachePolicy: normalized.cachePolicy,
    document: normalized.execution.document,
    operationName: normalized.execution.operationName,
    variables: normalized.execution.variables,
    smokeFailureAfterEpochMs: smokeFailureDeadline(env, normalized.execution.operationName),
  };
  const response = await dispatchGatewayOperation(normalized, {
    cached: (syntheticRequest) => ctx.exports.CachedAgrisProxy({ props }).fetch(syntheticRequest),
    execute: () => executeAgrisProxy(env, props),
  });
  return deliverGatewayResponse(response, props.cachePolicy);
}

export default {
  fetch(request: Request, env: DeployedAgrisProxyEnv, ctx: ExecutionContext): Promise<Response> {
    return agrisProxyWorker.fetch(request, deployedRuntime(env), ctx);
  },
} satisfies ExportedHandler<DeployedAgrisProxyEnv>;

function deployedRuntime(env: DeployedAgrisProxyEnv): AgrisProxyRuntimeEnv {
  return {
    MARKET: serviceBindingPort(env.MARKET),
    CATALOG: serviceBindingPort(env.CATALOG),
    ...("CACHE_SMOKE_MODE" in env ? { CACHE_SMOKE_MODE: env.CACHE_SMOKE_MODE } : undefined),
  };
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ export function serviceBindingPort(
  binding: unknown,
): ServiceBindingPort {
  // Wrangler records the named entrypoint but cannot emit RPC methods for a separately deployed service.
  // The checked-in service configuration is the authority for this narrow boundary type.
  // SAFETY: The owning guard or fixture establishes binding conforms to BudgetedSubgraphServiceBinding before this statement uses it.
  const budgetedBinding = binding as BudgetedSubgraphServiceBinding;
  return {
    fetch: (request, reserveBudget, reserveMarketSummary) =>
      budgetedBinding.fetchWithBudget(request, reserveBudget, reserveMarketSummary),
  };
}

export async function executeAgrisProxy(env: AgrisProxyRuntimeEnv, props: AgrisProxyExecutionProps): Promise<Response> {
  if (props.smokeFailureAfterEpochMs !== null && Date.now() >= props.smokeFailureAfterEpochMs) {
    return subgraphUnavailableResponse();
  }
  const subgraphs = new SubgraphExecution(env);
  const gateway = createGatewayRuntime({
    supergraph: supergraphSdl,
    graphiql: false,
    landingPage: false,
    logging: false,
    maskedErrors: true,
    transports: { http: httpTransport },
    plugins: () => [useCustomFetch((url, init) => subgraphs.fetch(url, init))],
  });
  const response = await gateway.fetch(
    new Request("https://agris-proxy.internal/graphql", {
      method: "POST",
      headers: {
        Accept: "application/graphql-response+json",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        query: props.document,
        operationName: props.operationName,
        variables: props.variables,
      }),
    }),
  );
  const bounded = await readBoundedGatewayResponseBody(response);
  if (!bounded.ok) return gatewayResponseTooLarge(bounded.status);
  const body = bounded.body;
  const hasGraphqlErrors = responseHasGraphqlErrors(body);
  const totalUpstreamUnavailable = subgraphs.totalUpstreamUnavailable();
  const classification = classifyGatewayResponse({
    cacheStatus: "MISS",
    cachePolicy: props.cachePolicy,
    hasGraphqlErrors,
    totalUpstreamUnavailable,
  });
  return new Response(body, {
    status: classification.status,
    headers: {
      "Cache-Control": classification.headers["Cache-Control"],
      "Content-Type": "application/graphql-response+json; charset=utf-8",
      [CACHE_WRITE_EPOCH_HEADER]: String(Date.now()),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function smokeFailureEnabled(env: AgrisProxyRuntimeEnv): boolean {
  return "CACHE_SMOKE_MODE" in env && env.CACHE_SMOKE_MODE === "enabled";
}

function smokeFailureDeadline(env: AgrisProxyRuntimeEnv, operationName: string | null): number | null {
  if (!smokeFailureEnabled(env) || operationName === null) return null;
  const encoded = /^CacheSmoke_(\d+)_/u.exec(operationName)?.[1];
  if (encoded === undefined) return null;
  const deadline = Number(encoded);
  return Number.isSafeInteger(deadline) && deadline > 0 ? deadline : null;
}

async function deliverGatewayResponse(response: Response, cachePolicy: GatewayCachePolicy): Promise<Response> {
  const bounded = await readBoundedGatewayResponseBody(response);
  if (!bounded.ok) return gatewayResponseTooLarge(bounded.status);
  const body = bounded.body;
  const cacheStatus = gatewayCacheStatus(response.headers.get("cf-cache-status"));
  const classification = classifyGatewayResponse({
    cacheStatus,
    cachePolicy,
    hasGraphqlErrors: responseHasGraphqlErrors(body),
    totalUpstreamUnavailable: response.status === 503,
  });
  return new Response(body, {
    status: classification.status,
    headers: {
      "Cache-Control":
        classification.status === 503
          ? classification.headers["Cache-Control"]
          : (response.headers.get("cache-control") ?? classification.headers["Cache-Control"]),
      "Content-Type": "application/graphql-response+json; charset=utf-8",
      "X-Central-Market-Refresh": classification.headers["X-Central-Market-Refresh"],
      "X-Central-Market-Source": classification.headers["X-Central-Market-Source"],
      "X-Content-Type-Options": "nosniff",
      ...forwardCacheEvidence(response.headers),
    },
  });
}

class SubgraphExecution {
  private attempts = 0;
  private readonly budget = new InvocationBudget();
  private readonly marketSummaryBudget = new MarketSummaryOperationBudget(undefined, {
    record: (event) => console.info(event),
  });
  private successes = 0;
  private readonly coordinator: ServiceBindingCoordinator;
  private readonly reserveBudget = invocationBudgetReservation(this.budget);
  private readonly reserveMarketSummary = marketSummaryReservation(this.marketSummaryBudget);

  public constructor(private readonly env: AgrisProxyRuntimeEnv) {
    this.coordinator = new ServiceBindingCoordinator({
      bindings: new Map([
        [MARKET_SUBGRAPH_URL, env.MARKET],
        [CATALOG_SUBGRAPH_URL, env.CATALOG],
      ]),
      budget: this.budget,
      marketSummaryBudget: this.marketSummaryBudget,
      timeout: createWorkerTimeoutPort(),
      timeoutMs: SUBGRAPH_TIMEOUT_MS,
    });
  }

  public async fetch(url: string, init?: RequestInit): Promise<Response> {
    this.attempts += 1;
    try {
      const response =
        url === CATALOG_SUBGRAPH_URL && this.env.LOCAL_INLINE_CATALOG === true
          ? await this.env.CATALOG.fetch(new Request(url, init), this.reserveBudget, this.reserveMarketSummary)
          : await this.coordinator.fetch(url, init);
      if (response.status >= 500) throw new ServiceBindingFailure("service-binding/unavailable");
      this.successes += 1;
      return response;
    } catch (error: unknown) {
      if (!(error instanceof ServiceBindingFailure)) throw error;
      return subgraphUnavailableResponse();
    }
  }

  public totalUpstreamUnavailable(): boolean {
    return this.attempts > 0 && this.successes === 0;
  }
}

function subgraphUnavailableResponse(): Response {
  return Response.json(
    { errors: [{ message: "Central Market subgraph unavailable" }] },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

function gatewayResponseTooLarge(status: 502): Response {
  return gatewayError(status, "Agris Proxy response exceeds the accepted size");
}

function responseHasGraphqlErrors(body: string): boolean {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) && Array.isArray(value.errors) && value.errors.length > 0;
  } catch {
    return true;
  }
}

function gatewayCacheStatus(value: string | null): GatewayCacheStatus {
  const normalized = value?.toUpperCase();
  if (
    normalized === "HIT" ||
    normalized === "MISS" ||
    normalized === "EXPIRED" ||
    normalized === "REVALIDATED" ||
    normalized === "STALE" ||
    normalized === "UPDATING"
  ) {
    return normalized;
  }
  return "BYPASS";
}

function forwardCacheEvidence(headers: Headers) {
  const evidence: Record<string, string> = {};
  const age = headers.get("age");
  const cacheStatus = headers.get("cf-cache-status");
  const cacheWriteEpochMs = Number(headers.get(CACHE_WRITE_EPOCH_HEADER));
  if (age !== null) {
    evidence.Age = age;
  } else if (
    (cacheStatus === "HIT" || cacheStatus === "STALE" || cacheStatus === "UPDATING") &&
    Number.isSafeInteger(cacheWriteEpochMs) &&
    cacheWriteEpochMs > 0
  ) {
    evidence.Age = String(Math.max(0, Math.floor((Date.now() - cacheWriteEpochMs) / 1_000)));
  }
  if (cacheStatus !== null) evidence["Cf-Cache-Status"] = cacheStatus;
  return evidence;
}

export function gatewayError(status: number, message: string): Response {
  return Response.json(
    { errors: [{ message }] },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/graphql-response+json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
