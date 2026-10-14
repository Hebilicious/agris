import {
  cacheFreshnessFromBindings,
  classifyGatewayResponse,
  createGatewayRequestProtocol,
  dispatchGatewayOperation,
  readBoundedGatewayRequestBody,
  readBoundedGatewayResponseBody,
  ServiceBindingCoordinator,
  ServiceBindingFailure,
  type ServiceBindingPort,
  type CacheFreshnessPolicy,
  type GatewayCachePolicy,
  type GatewayCacheStatus,
  type GatewayRequestProtocol,
  type GatewayUpstreamOutcome,
  type JsonObject,
  type NormalizedGatewayRequest,
} from "@agris/core";
import { createWorkerTimeoutPort } from "@agris/worker-runtime";
import {
  DEFAULT_SUBREQUEST_LIMIT,
  InvocationBudget,
  invocationBudgetReservation,
  MarketSummaryOperationBudget,
  marketSummaryRequestLimitFor,
  marketSummaryReservation,
  type InvocationBudgetReservation,
  type MarketSummaryReservation,
} from "@agris/invocation-budget";
import { createGatewayRuntime, useCustomFetch, type GatewayPlugin } from "@graphql-hive/gateway-runtime";
import httpTransport from "@graphql-mesh/transport-http";
import { buildSchema } from "graphql";
import { Predicate } from "effect";

import { clientSchemaSdl, supergraphSdl } from "../../../tools/schema/artifacts/gateway-schemas.js";
import {
  ADMISSION_UNAVAILABLE_RETRY_SECONDS,
  admissionObjectName,
  admitThrough,
  withClientAdmissionKey,
  type MarketAdmission,
} from "./admission.js";
import { gatewayPlugins } from "./plugins.js";

/**
 * The Agris gateway, independent of how a Worker hosts it.
 *
 * The Worker's own entrypoints in `index.ts` and `public.ts`, and the Alchemy Workers under `infra/`, all serve through
 * this module. It imports nothing from the Workers runtime and no `.graphql` text module, so a deploy tool can load it.
 */

const MARKET_SUBGRAPH_URL = "https://central-market-market.internal/graphql";
const CATALOG_SUBGRAPH_URL = "https://central-market-catalog.internal/graphql";
const GRAPHQL_PATH = "/graphql";
const SUBGRAPH_TIMEOUT_MS = 35_000;
const CACHE_WRITE_EPOCH_HEADER = "x-central-market-cache-write-epoch-ms";
/** Marks an execution's 503 as a throttle rather than an outage; `deliverGatewayResponse` reads it and never sends it on. */
const THROTTLED_EXECUTION_HEADER = "x-agris-upstream-outcome";
/** How long a rate-limited caller waits when the subgraph that was refused named no time: a Workers rate-limit window. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

export interface AgrisProxyRuntimeEnv {
  readonly CATALOG: ServiceBindingPort;
  readonly MARKET: ServiceBindingPort;
  readonly CACHE_SMOKE_MODE?: "enabled";
  readonly LOCAL_INLINE_CATALOG?: true;
  /** The deployment's cache freshness policy; absent is `DEFAULT_CACHE_FRESHNESS`. */
  readonly cacheFreshness?: CacheFreshnessPolicy;
  /** The Envelop plugins every execution runs; absent is `gatewayPlugins` from `plugins.ts`. */
  readonly plugins?: readonly GatewayPlugin[];
  /**
   * The subrequests one execution may spend, Service Binding calls and Pearl Abyss requests together; it must not
   * exceed the Worker's `limits.subrequests`. Absent is `DEFAULT_SUBREQUEST_LIMIT`.
   */
  readonly subrequestLimit?: number;
  /**
   * The exact market admission: an execution for a public caller asks its client's `GatewayAdmission` bucket once,
   * before its first market subgraph call, and spends one subrequest of its budget doing so. Absent admits every
   * market call; a cache hit or a catalog-only execution never asks.
   */
  readonly marketAdmission?: MarketAdmission;
}

export interface BudgetedSubgraphServiceBinding {
  fetchWithBudget(
    request: Request,
    reserveBudget: InvocationBudgetReservation,
    reserveMarketSummary: MarketSummaryReservation,
  ): Promise<Response>;
}

/** The client schema every caller's documents are validated against. */
export const clientSchema = buildSchema(clientSchemaSdl);
const defaultProtocol = createGatewayRequestProtocol({ schema: clientSchema });
const configuredProtocols = new WeakMap<CacheFreshnessPolicy, GatewayRequestProtocol>();
const configuredFreshness = new Map<string, CacheFreshnessPolicy>();

/**
 * The policy a deployment's `CACHE_*` bindings select, validated against the client schema once per distinct set of
 * values; `undefined` when it binds none. An invalid value throws on every request, so a bad configuration fails loudly
 * instead of falling back to the defaults.
 */
export function deploymentCacheFreshness(bindings: object): CacheFreshnessPolicy | undefined {
  const settings = Object.entries(bindings).filter(
    ([name]) => name.startsWith("CACHE_") && name !== "CACHE_SMOKE_MODE",
  );
  if (settings.length === 0) return undefined;
  const key = JSON.stringify(settings.map(([name, value]) => [name, Predicate.isObject(value) ? "[binding]" : value]));
  const existing = configuredFreshness.get(key);
  if (existing !== undefined) return existing;
  const policy = cacheFreshnessFromBindings(bindings, clientSchema);
  configuredFreshness.set(key, policy);
  return policy;
}

function privateProtocol(cacheFreshness: CacheFreshnessPolicy | undefined): GatewayRequestProtocol {
  if (cacheFreshness === undefined) return defaultProtocol;
  const existing = configuredProtocols.get(cacheFreshness);
  if (existing !== undefined) return existing;
  const protocol = createGatewayRequestProtocol({ schema: clientSchema, cacheFreshness });
  configuredProtocols.set(cacheFreshness, protocol);
  return protocol;
}

export interface AgrisProxyExecutionProps {
  readonly cachePolicy: GatewayCachePolicy;
  readonly document: string;
  readonly operationName: string | null;
  readonly variables: JsonObject;
  readonly smokeFailureAfterEpochMs: number | null;
}

/**
 * Serve one cacheable operation through the host's edge cache: the synthetic request is the cache key, and the props
 * are the operation a cache miss executes.
 */
export type CachedAgrisProxyExecution = (
  syntheticRequest: Request,
  props: AgrisProxyExecutionProps,
) => Promise<Response>;

/** Answer one private GraphQL POST: validate it against the client schema and serve it, cached when it may be. */
export async function handleAgrisProxyRequest(
  request: Request,
  env: AgrisProxyRuntimeEnv,
  cached: CachedAgrisProxyExecution,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname !== GRAPHQL_PATH) return gatewayError(404, "Not found");

  const bodyText = await readBoundedGatewayRequestBody(request);
  if (bodyText === undefined) return gatewayError(400, "GraphQL request body exceeds the accepted size");
  const normalized = await privateProtocol(env.cacheFreshness).normalize({
    method: request.method,
    contentType: request.headers.get("content-type"),
    searchParams: requestUrl.search.slice(1),
    bodyText,
  });
  if (!normalized.ok) return gatewayError(normalized.error.status, normalized.error.message);
  return serveGatewayOperationWith(normalized.value, env, cached);
}

/**
 * Serve one normalized operation: through `cached`, the host's edge-cached execution, when its policy stores it,
 * otherwise directly. `clientKey` is the public caller's admission key (`clientAdmissionKey`), or `null` for a private
 * caller: an execution admits its market calls under it, and the cache key request carries it in a header, which
 * Workers Cache does not key on, so every client shares the stored answers.
 */
export async function serveGatewayOperationWith(
  normalized: NormalizedGatewayRequest,
  env: AgrisProxyRuntimeEnv,
  cached: CachedAgrisProxyExecution,
  clientKey: string | null = null,
): Promise<Response> {
  const props: AgrisProxyExecutionProps = {
    cachePolicy: normalized.cachePolicy,
    document: normalized.execution.document,
    operationName: normalized.execution.operationName,
    variables: normalized.execution.variables,
    smokeFailureAfterEpochMs: smokeFailureDeadline(env, normalized.execution.operationName),
  };
  const response = await dispatchGatewayOperation(normalized, {
    cached: (syntheticRequest) => cached(withClientAdmissionKey(syntheticRequest, clientKey), props),
    execute: () => executeAgrisProxy(env, props, clientKey),
  });
  return deliverGatewayResponse(response, props.cachePolicy);
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ export function serviceBindingPort(
  binding: unknown,
): ServiceBindingPort {
  // A service binding's type names the entrypoint but not the RPC methods of a separately deployed service.
  // The deployment's service configuration is the authority for this narrow boundary type.
  // SAFETY: The owning guard or fixture establishes binding conforms to BudgetedSubgraphServiceBinding before this statement uses it.
  const budgetedBinding = binding as BudgetedSubgraphServiceBinding;
  return {
    fetch: (request, reserveBudget, reserveMarketSummary) =>
      budgetedBinding.fetchWithBudget(request, reserveBudget, reserveMarketSummary),
  };
}

/** The key under which one execution's subgraph calls ride in the gateway's context. */
const SUBGRAPH_EXECUTION = "agrisSubgraphExecution";

interface SubgraphExecutionContext {
  readonly [SUBGRAPH_EXECUTION]: SubgraphExecution;
}

const gatewayRuntimes = new WeakMap<readonly GatewayPlugin[], ReturnType<typeof createGatewayRuntime>>();

/**
 * One Hive Gateway runtime per plugin list, built on first use and kept for the isolate's life. Building one parses
 * the supergraph and plans nothing yet; keeping it means each execution reuses the parsed schema and the cached query
 * plans, which is most of an execution's CPU time. Each execution's own subgraph calls and budget reach the shared
 * runtime through its context.
 */
function gatewayRuntimeFor(plugins: readonly GatewayPlugin[]): ReturnType<typeof createGatewayRuntime> {
  const existing = gatewayRuntimes.get(plugins);
  if (existing !== undefined) return existing;
  const runtime = createGatewayRuntime({
    supergraph: supergraphSdl,
    graphiql: false,
    landingPage: false,
    logging: false,
    // Masks errors the gateway itself throws. A subgraph's errors pass as the subgraph wrote them, so each subgraph
    // masks its own: the market subgraph lets only its closed set of codes and messages out. `isDev: false` keeps the
    // original error and its stack out of the answer even where NODE_ENV says development, as Yoga would otherwise.
    maskedErrors: { isDev: false },
    transports: { http: httpTransport },
    plugins: () => [useCustomFetch((url, init, context) => subgraphExecutionOf(context).fetch(url, init)), ...plugins],
  });
  gatewayRuntimes.set(plugins, runtime);
  return runtime;
}

/* BOUNDARY: The gateway hands each subgraph call the execution's context; it must carry that execution's calls. */
function subgraphExecutionOf(context: unknown): SubgraphExecution {
  const execution: unknown = Predicate.hasProperty(context, SUBGRAPH_EXECUTION)
    ? context[SUBGRAPH_EXECUTION]
    : undefined;
  if (!(execution instanceof SubgraphExecution)) throw new TypeError("A subgraph call arrived without its execution");
  return execution;
}

/**
 * Execute one operation over the subgraphs, with Agris's subgraph fetch and then the extension point's plugins. A
 * `clientKey` (a public caller's, from `clientAdmissionKeyOf` on the cache key request) has the execution admit its
 * market calls through `env.marketAdmission`; `null` admits them all.
 */
export async function executeAgrisProxy(
  env: AgrisProxyRuntimeEnv,
  props: AgrisProxyExecutionProps,
  clientKey: string | null = null,
): Promise<Response> {
  if (props.smokeFailureAfterEpochMs !== null && Date.now() >= props.smokeFailureAfterEpochMs) {
    return subgraphUnavailableResponse();
  }
  const subgraphs = new SubgraphExecution(env, clientKey);
  const executionContext: SubgraphExecutionContext = { [SUBGRAPH_EXECUTION]: subgraphs };
  const response = await gatewayRuntimeFor(env.plugins ?? gatewayPlugins).fetch(
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
    executionContext,
  );
  const bounded = await readBoundedGatewayResponseBody(response);
  if (!bounded.ok) return gatewayResponseTooLarge(bounded.status);
  const body = bounded.body;
  const hasGraphqlErrors = responseHasGraphqlErrors(body);
  const upstream = subgraphs.upstreamOutcome();
  const classification = classifyGatewayResponse({
    cacheStatus: "MISS",
    cachePolicy: props.cachePolicy,
    hasGraphqlErrors,
    upstream,
  });
  // A throttled execution, by Pearl Abyss's limit or by the client's market admission, leaves the edge cache as a 503,
  // the only failure Workers Cache answers with a stale entry (`stale-if-error`); the marker tells
  // `deliverGatewayResponse` to turn it into the caller's 429.
  const throttled = upstream === "rate-limited";
  return new Response(body, {
    status: throttled ? 503 : classification.status,
    headers: {
      "Cache-Control": classification.headers["Cache-Control"],
      "Content-Type": "application/graphql-response+json; charset=utf-8",
      [CACHE_WRITE_EPOCH_HEADER]: String(Date.now()),
      "X-Content-Type-Options": "nosniff",
      ...(throttled
        ? { "Retry-After": String(subgraphs.retryAfterSeconds()), [THROTTLED_EXECUTION_HEADER]: "rate-limited" }
        : {}),
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
  // A stale entry the edge served in place of a throttled execution is a 200 without the marker, and passes as data.
  const upstream = upstreamOutcomeOf(response.status, response.headers.get(THROTTLED_EXECUTION_HEADER));
  const classification = classifyGatewayResponse({
    cacheStatus,
    cachePolicy,
    hasGraphqlErrors: responseHasGraphqlErrors(body),
    upstream,
  });
  const retryAfter = response.headers.get("retry-after");
  return new Response(body, {
    status: classification.status,
    headers: {
      "Cache-Control":
        upstream === "answered"
          ? (response.headers.get("cache-control") ?? classification.headers["Cache-Control"])
          : classification.headers["Cache-Control"],
      ...(upstream === "rate-limited" && retryAfter !== null ? { "Retry-After": retryAfter } : {}),
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
  private readonly budget: InvocationBudget;
  private readonly marketSummaryBudget: MarketSummaryOperationBudget;
  private successes = 0;
  /** The longest `Retry-After` of the subgraph calls a limiter refused; `null` while none was. */
  private rateLimitedRetryAfterSeconds: number | null = null;
  private readonly coordinator: ServiceBindingCoordinator;
  private readonly reserveBudget: InvocationBudgetReservation;
  private readonly reserveMarketSummary: MarketSummaryReservation;
  private readonly env: AgrisProxyRuntimeEnv;
  /** The client's bucket and rate, when this execution admits its market calls. */
  private readonly admission: (MarketAdmission & { readonly clientKey: string }) | undefined;
  /** The one admission decision every market call of this execution shares, once the first one asked. */
  private marketAdmission: Promise<MarketAdmissionOutcome> | undefined;

  public constructor(env: AgrisProxyRuntimeEnv, clientKey: string | null) {
    this.env = env;
    this.admission =
      env.marketAdmission === undefined || clientKey === null ? undefined : { ...env.marketAdmission, clientKey };
    const subrequestLimit = env.subrequestLimit ?? DEFAULT_SUBREQUEST_LIMIT;
    this.budget = new InvocationBudget(subrequestLimit);
    this.marketSummaryBudget = new MarketSummaryOperationBudget(marketSummaryRequestLimitFor(subrequestLimit), {
      record: (event) => console.info(event),
    });
    this.reserveBudget = invocationBudgetReservation(this.budget);
    this.reserveMarketSummary = marketSummaryReservation(this.marketSummaryBudget);
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
          : url === MARKET_SUBGRAPH_URL
            ? await this.fetchMarket(url, init)
            : await this.coordinator.fetch(url, init);
      if (response.status >= 500) throw new ServiceBindingFailure("service-binding/unavailable");
      if (response.status === 429) {
        // The subgraph read nothing because a limiter refused it; its body still carries the field errors.
        this.rateLimitedRetryAfterSeconds = Math.max(
          this.rateLimitedRetryAfterSeconds ?? 0,
          retryAfterSecondsOf(response.headers.get("retry-after")),
        );
        return new Response(response.body, { status: 200, headers: response.headers });
      }
      this.successes += 1;
      return response;
    } catch (error: unknown) {
      if (!(error instanceof ServiceBindingFailure)) throw error;
      if (error.code === "service-binding/budget-exceeded") {
        // The query asked for more than the subrequest limit allows; the subgraphs are fine.
        this.successes += 1;
        return subgraphBudgetExceededResponse();
      }
      return subgraphUnavailableResponse();
    }
  }

  /**
   * A market subgraph call, admitted first when this execution admits its market calls. A refusal reads like the
   * market's own throttle, a 429 with `Retry-After` and a `RATE_LIMITED` error, so the caller gets a stale cached answer
   * when the edge keeps one and a 429 otherwise.
   */
  private async fetchMarket(url: string, init: RequestInit | undefined): Promise<Response> {
    const outcome = await this.admitMarket();
    if (outcome === "over-budget") throw new ServiceBindingFailure("service-binding/budget-exceeded");
    if (outcome !== "admitted") return marketAdmissionRefusedResponse(outcome.retryAfterSeconds);
    return this.coordinator.fetch(url, init);
  }

  private admitMarket(): Promise<MarketAdmissionOutcome> {
    if (this.admission === undefined) return Promise.resolve("admitted");
    this.marketAdmission ??= askMarketAdmission(this.admission, this.budget);
    return this.marketAdmission;
  }

  /** `answered` when any subgraph call answered; otherwise `rate-limited` when one was throttled, else `unavailable`. */
  public upstreamOutcome(): GatewayUpstreamOutcome {
    if (this.attempts === 0 || this.successes > 0) return "answered";
    return this.rateLimitedRetryAfterSeconds === null ? "unavailable" : "rate-limited";
  }

  /** The longest `Retry-After` a rate-limited subgraph asked for. */
  public retryAfterSeconds(): number {
    return this.rateLimitedRetryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
  }
}

/** An execution's market admission: admitted, refused until `retryAfterSeconds`, or beyond its subrequest budget. */
type MarketAdmissionOutcome = "admitted" | "over-budget" | { readonly retryAfterSeconds: number };

/**
 * Ask the client's `GatewayAdmission` bucket once. The call is a subrequest, so it spends one of the execution's
 * budget. Admission fails closed: an object that cannot answer refuses the market calls for a few seconds, since an
 * overloaded object is exactly what a flood causes.
 */
async function askMarketAdmission(
  admission: MarketAdmission & { readonly clientKey: string },
  budget: InvocationBudget,
): Promise<MarketAdmissionOutcome> {
  if (!budget.reserve(1).ok) return "over-budget";
  const name = admissionObjectName(admission.clientKey);
  try {
    const decision = await admitThrough(admission.namespace, name, admission.rate);
    return decision.admitted ? "admitted" : { retryAfterSeconds: decision.retryAfterSeconds };
  } catch (error: unknown) {
    console.error({ event: "gateway-admission-unavailable", name, error: String(error) });
    return { retryAfterSeconds: ADMISSION_UNAVAILABLE_RETRY_SECONDS };
  }
}

/** A market call the client's admission refused, as the market subgraph answers a throttled read. */
function marketAdmissionRefusedResponse(retryAfterSeconds: number): Response {
  return Response.json(
    {
      data: null,
      errors: [
        {
          message: `This client is reading the Central Market too often. Retry after ${retryAfterSeconds} seconds.`,
          extensions: { code: "RATE_LIMITED" },
        },
      ],
    },
    { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfterSeconds) } },
  );
}

/* BOUNDARY: An execution's status and its throttle marker, which only `executeAgrisProxy` sets. */
function upstreamOutcomeOf(status: number, throttleMarker: string | null): GatewayUpstreamOutcome {
  if (status === 503) return throttleMarker === "rate-limited" ? "rate-limited" : "unavailable";
  if (status === 429) return "rate-limited";
  return "answered";
}

/*
 * BOUNDARY: A subgraph's `Retry-After`, which Agris sends as whole seconds; anything else waits the default. A wait
 * under one second is one, so a refused caller never hears it may retry at once.
 */
function retryAfterSecondsOf(value: string | null): number {
  if (value === null || !/^\d{1,6}$/u.test(value)) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.max(1, Number(value));
}

function subgraphUnavailableResponse(): Response {
  return Response.json(
    { errors: [{ message: "Central Market subgraph unavailable" }] },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

function subgraphBudgetExceededResponse(): Response {
  return Response.json(
    {
      errors: [
        {
          message: "The query needs more subgraph calls than this deployment's subrequest limit allows",
          extensions: { code: "QUERY_BUDGET_EXCEEDED" },
        },
      ],
    },
    { headers: { "Cache-Control": "no-store" } },
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
