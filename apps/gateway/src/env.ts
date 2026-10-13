/**
 * The bindings the gateway Worker reads. A deployment configuration, this repository's or a host's, must provide them;
 * `infra/src/smoke/env.check.ts` proves the smoke stage, which deploys this entrypoint as a host does, provides them.
 *
 * Besides these, the gateway reads its cache settings from plain-text `CACHE_*` variables (`CACHE_SETTING_NAMES` in
 * `@agris/core`), each optional: a deployment that binds none runs `DEFAULT_CACHE_FRESHNESS`, and the gateway refuses a
 * `CACHE_` variable it does not know.
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
}

/** The cache-smoke deployment, which can make its subgraphs fail on request. */
export interface SmokeGatewayEnv extends GatewayEnv {
  readonly CACHE_SMOKE_MODE: "enabled";
}

/** The local gateway serves the catalog inline, so it binds only the local market Worker. */
export interface LocalGatewayEnv {
  readonly MARKET: Fetcher;
}

/** A Cloudflare `ratelimit` binding, as far as the public gateway uses it. */
export interface RateLimitPort {
  limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

/** A Workers static-assets binding, as far as the public gateway uses it. */
export interface AssetsPort {
  fetch(request: Request): Promise<Response>;
}

/**
 * The public gateway (`src/public.ts`): the private bindings plus the optional ones that shape a public deployment.
 * Every optional binding may be left out; the gateway then skips what it controls. It also reads the cache settings
 * and the `QUERY_*` limits (`QUERY_LIMIT_SETTING` in `@agris/core`), each optional.
 */
export interface PublicGatewayEnv extends GatewayEnv {
  /** Limits each client, keyed by `CF-Connecting-IP`; absent limits no client. */
  readonly CLIENT_RATE_LIMITER?: RateLimitPort;
  /** Limits the whole deployment under one constant key; absent sets no deployment-wide limit. */
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
