import * as Cloudflare from "alchemy/Cloudflare";

import { DEFAULT_SUBREQUEST_LIMIT } from "@agris/invocation-budget/subrequest-limit";

import { workerNames } from "../settings.ts";
import { bundleOptions, compatibility, observability, privateSurface, subrequestLimit } from "../stack.ts";

/**
 * The cache smoke's stage. It deploys the Workers' own entrypoints (`@agris/gateway-worker`, `@agris/market-worker`,
 * `@agris/catalog-worker`) as plain Workers, the way a host that mounts Agris deploys them, and a public caller bound
 * to the private gateway. `moon run smoke:smoke` deploys it and runs the smoke; `moon run infra:smoke-destroy` deletes
 * it.
 */
export const SMOKE_STAGE = "smoke";

const names = workerNames(SMOKE_STAGE);
const sampling = { logs: 1, traces: 0.05 };

/** Each smoke Worker's entry module, by logical ID: the three Workers' own entrypoints, and the caller. */
export const SMOKE_WORKER_MAIN = {
  HostGateway: import.meta.resolve("@agris/gateway-worker"),
  HostMarket: import.meta.resolve("@agris/market-worker"),
  HostCatalog: import.meta.resolve("@agris/catalog-worker"),
  SmokeCaller: new URL("../../../tools/smoke/caller/src/index.ts", import.meta.url).href,
} as const;

/** A Worker that only another Worker in the account reaches, with the settings every smoke Worker shares. */
function privateWorker(name: string, main: string) {
  return {
    name,
    main,
    compatibility: compatibility(),
    build: bundleOptions(),
    workersDev: privateSurface(),
    observability: observability(sampling),
  };
}

/** The market Worker's entrypoint with its coordinators, Pearl Abyss limits and subrequest budget. */
export function hostMarketProps() {
  return {
    ...privateWorker(names.market, SMOKE_WORKER_MAIN.HostMarket),
    limits: subrequestLimit(DEFAULT_SUBREQUEST_LIMIT).limits,
    env: {
      MARKET_ENVIRONMENT: "staging",
      ...subrequestLimit(DEFAULT_SUBREQUEST_LIMIT).variable,
      PA_MAX_CONCURRENT_REQUESTS: "6",
      PA_COORDINATOR: Cloudflare.DurableObject("PearlAbyssCoordinator"),
      PA_RATE_LIMITER: Cloudflare.RateLimit("PA_RATE_LIMITER", {
        namespaceId: "42002",
        simple: { limit: 100, period: 10 },
      }),
    },
  };
}

/** The catalog Worker's entrypoint; it binds nothing. */
export function hostCatalogProps() {
  return privateWorker(names.catalog, SMOKE_WORKER_MAIN.HostCatalog);
}

/**
 * The private gateway entrypoint, with Workers Cache on its `CachedAgrisProxy` entrypoint only, which the default
 * entrypoint calls back through `ctx.exports`. `CACHE_SMOKE_MODE` lets the smoke make a refresh fail on request.
 */
export function hostGatewayProps(market: Cloudflare.Worker, catalog: Cloudflare.Worker) {
  return {
    ...privateWorker(names.gateway, SMOKE_WORKER_MAIN.HostGateway),
    limits: subrequestLimit(DEFAULT_SUBREQUEST_LIMIT).limits,
    cache: { enabled: false, crossVersionCache: false },
    entrypoints: { CachedAgrisProxy: { cache: { enabled: true } } },
    env: {
      MARKET: Cloudflare.WorkerEntrypoint(market, "BudgetedMarketSubgraph"),
      CATALOG: Cloudflare.WorkerEntrypoint(catalog, "BudgetedCatalogSubgraph"),
      ...subrequestLimit(DEFAULT_SUBREQUEST_LIMIT).variable,
      CACHE_SMOKE_MODE: "enabled" as const,
      // The smoke's own price window, whatever the defaults: thirty seconds fresh and no stale-while-revalidate, so once
      // the entry expires its refresh runs before the answer and a failed refresh serves it as STALE.
      CACHE_MARKET_ITEMS_MAX_AGE_SECONDS: "30",
      CACHE_MARKET_ITEMS_STALE_WHILE_REVALIDATE_SECONDS: "0",
    },
  };
}

/** The caller the smoke reaches over `workers.dev`, which forwards each GraphQL request to the private gateway. */
export function smokeCallerProps(gateway: Cloudflare.Worker) {
  return {
    name: `${names.gateway}-caller`,
    main: SMOKE_WORKER_MAIN.SmokeCaller,
    compatibility: compatibility(),
    build: bundleOptions(),
    workersDev: { enabled: true, previewsEnabled: false },
    observability: observability(sampling),
    env: { AGRIS_PROXY: gateway },
  };
}
