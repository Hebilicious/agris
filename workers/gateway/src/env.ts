/**
 * The bindings the gateway Worker reads. A deployment configuration, this repository's or a host's, must provide them;
 * `config-env.check.ts` proves this repository's `cloudflare.config.ts` does.
 */
export interface GatewayEnv {
  /** The market Worker's `BudgetedMarketSubgraph` entrypoint. */
  readonly MARKET: Fetcher;
  /** The catalog Worker's `BudgetedCatalogSubgraph` entrypoint. */
  readonly CATALOG: Fetcher;
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
 * Every optional binding may be left out; the gateway then skips what it controls.
 */
export interface PublicGatewayEnv extends GatewayEnv {
  /** Limits each client, keyed by `CF-Connecting-IP`. */
  readonly CLIENT_RATE_LIMITER?: RateLimitPort;
  /** Limits the whole deployment under one constant key. */
  readonly GLOBAL_RATE_LIMITER?: RateLimitPort;
  /** Serves every path that is not `/graphql` or `/health`. */
  readonly ASSETS?: AssetsPort;
  /** When set, every response carries it as `X-Agris-Demo`. */
  readonly DEMO_NOTICE?: string;
  /** Where a rate-limited caller learns to deploy their own Agris. */
  readonly DEPLOY_GUIDE_URL?: string;
  /** Raises every storable result's edge freshness to at least this many seconds. */
  readonly MARKET_CACHE_MIN_TTL_SECONDS?: number;
  /** `"enabled"` (the default) or `"disabled"`: whether browsers opening `GET /graphql` get GraphiQL. */
  readonly GRAPHIQL?: string;
}
