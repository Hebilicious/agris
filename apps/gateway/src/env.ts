import type { AdmissionNamespacePort } from "./admission.js";

/**
 * The bindings the gateway Worker reads. A deployment configuration, this repository's or a host's, must provide them;
 * `infra/src/smoke/env.check.ts` proves the smoke stage, which deploys this entrypoint as a host does, provides them.
 *
 * A deployment that binds no `CACHE_*` setting runs `DEFAULT_CACHE_FRESHNESS`, and the gateway refuses a `CACHE_`
 * variable it does not know.
 */
export interface GatewayEnv {
  /** The market Worker's `BudgetedMarketSubgraph` entrypoint. */
  readonly MARKET: Fetcher;
  /** The catalog Worker's `BudgetedCatalogSubgraph` entrypoint. */
  readonly CATALOG: Fetcher;
  /**
   * The Worker's `limits.subrequests`, which one execution may spend; absent is 50 (`subrequestLimitFromBinding` in
   * `@agris/invocation-budget`). A deployment that raises `limits.subrequests` sets this to the same number.
   */
  readonly SUBREQUEST_LIMIT?: string;
  /**
   * The cache settings (`CACHE_SETTING_NAMES` in `@agris/core`): plain text, or a JSON number or boolean where the
   * setting takes one. Every one is optional.
   */
  readonly [cacheSetting: `CACHE_${string}`]: string | number | boolean | undefined;
}

/** The cache-smoke deployment, which can make its subgraphs fail on request. */
export interface SmokeGatewayEnv extends GatewayEnv {
  readonly CACHE_SMOKE_MODE: "enabled";
}

/**
 * The local gateway serves the catalog inline, so it binds only the local market Worker. It reads `SUBREQUEST_LIMIT`
 * and the `CACHE_*` settings as the deployed gateway does.
 */
export type LocalGatewayEnv = Omit<GatewayEnv, "CATALOG">;

/** A Cloudflare `ratelimit` binding, as far as the public gateway uses it. */
export interface RateLimitPort {
  limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

/** A Workers static-assets binding, as far as the public gateway uses it. */
export interface AssetsPort {
  fetch(request: Request): Promise<Response>;
}

/**
 * The exact market admission, which the executions behind the public gateway read: the public gateway itself for an
 * uncacheable operation, and the cached execution (`CachedAgrisProxy`) on a cache miss. Each binding is optional; a
 * private caller is never admitted, whatever they set.
 */
export interface MarketAdmissionEnv {
  /**
   * This Worker's own `GatewayAdmission` Durable Object class (`src/public.ts`), which keeps one exact token bucket per
   * client. Required when `MARKET_CLIENT_LIMIT_REQUESTS` is set.
   */
  readonly ADMISSION?: AdmissionNamespacePort;
  /**
   * Exact market executions per client per `MARKET_CLIENT_LIMIT_PERIOD_SECONDS`, asked only before an execution's first
   * market subgraph call; absent or `"0"` sets none.
   */
  readonly MARKET_CLIENT_LIMIT_REQUESTS?: string;
  /** The exact market admission's period in seconds; absent is 60. */
  readonly MARKET_CLIENT_LIMIT_PERIOD_SECONDS?: string;
}

/**
 * The public gateway (`src/public.ts`): the private bindings plus the optional ones that shape a public deployment.
 * Every optional binding may be left out; the gateway then skips what it controls. It also reads the cache settings
 * and the `QUERY_*` limits (`QUERY_LIMIT_SETTING` in `@agris/core`), each optional.
 *
 * Every request, whatever its path, passes the rate-limit bindings first, when bound: they count per Cloudflare
 * location and add no round trip. An execution that is about to call the market subgraph is then admitted exactly by
 * its client's `GatewayAdmission` bucket, when `MARKET_CLIENT_LIMIT_REQUESTS` is set (`MarketAdmissionEnv`).
 */
export interface PublicGatewayEnv extends GatewayEnv, MarketAdmissionEnv {
  /**
   * Limits each client, keyed by `CF-Connecting-IP` (an IPv6 address by its /64); absent limits no client here.
   * Cloudflare counts it per location and approximately.
   */
  readonly CLIENT_RATE_LIMITER?: RateLimitPort;
  /** Limits the whole deployment under one constant key, counted per location; absent sets none. */
  readonly GLOBAL_RATE_LIMITER?: RateLimitPort;
  /** Serves every path that is not `/graphql` or `/health`. */
  readonly ASSETS?: AssetsPort;
  /** When set, every response carries it as `X-Agris-Demo`. */
  readonly DEMO_NOTICE?: string;
  /** Where a rate-limited caller learns to deploy their own Agris. */
  readonly DEPLOY_GUIDE_URL?: string;
  /** `"enabled"` (the default) or `"disabled"`: whether browsers opening `GET /graphql` get GraphiQL. */
  readonly GRAPHIQL?: string;
}

/** The public gateway's optional bindings and variables, whichever way a Worker reaches its subgraphs. */
export type PublicGatewaySettings = Omit<PublicGatewayEnv, "MARKET" | "CATALOG">;
