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
 * The public gateway (`src/public.ts`): the private bindings plus the optional ones that shape a public deployment.
 * Every optional binding may be left out; the gateway then skips what it controls. It also reads the cache settings
 * and the `QUERY_*` limits (`QUERY_LIMIT_SETTING` in `@agris/core`), each optional.
 *
 * Every request, whatever its path, is admitted first: by the rate-limit bindings when bound, a cheap per-location
 * first line, and then by the exact `ADMISSION_*` limits, which the `ADMISSION` Durable Object keeps.
 */
export interface PublicGatewayEnv extends GatewayEnv {
  /**
   * Cheap first line per client, keyed by `CF-Connecting-IP` (an IPv6 address by its /64); absent limits no client
   * here. Cloudflare counts it per location and approximately, so it is never the guarantee.
   */
  readonly CLIENT_RATE_LIMITER?: RateLimitPort;
  /** Cheap first line for the whole deployment under one constant key, counted per location; absent sets none. */
  readonly GLOBAL_RATE_LIMITER?: RateLimitPort;
  /**
   * This Worker's own `GatewayAdmission` Durable Object class (`src/public.ts`), which keeps the exact limits. Required
   * when either exact limit is set.
   */
  readonly ADMISSION?: AdmissionNamespacePort;
  /** Exact requests per client per `ADMISSION_CLIENT_PERIOD_SECONDS`; absent or `"0"` sets no exact client limit. */
  readonly ADMISSION_CLIENT_REQUESTS?: string;
  /** The exact client limit's period in seconds; absent is 60. */
  readonly ADMISSION_CLIENT_PERIOD_SECONDS?: string;
  /** Exact requests for the whole deployment per `ADMISSION_GLOBAL_PERIOD_SECONDS`; absent or `"0"` sets none. */
  readonly ADMISSION_GLOBAL_REQUESTS?: string;
  /** The exact deployment-wide limit's period in seconds; absent is 60. */
  readonly ADMISSION_GLOBAL_PERIOD_SECONDS?: string;
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
