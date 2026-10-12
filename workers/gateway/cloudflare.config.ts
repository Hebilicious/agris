import { bindings, defineConfig, defineWorker, exports } from "cf/config";

/**
 * The Agris gateway Worker, one mode per deployment and local runtime.
 *
 * No account is named here: `cf` deploys to the account the deployer's credentials select. Rate-limit namespace IDs
 * are scoped to the account, so a host that deploys these Workers beside other rate-limited Workers picks its own.
 */

const proxySettings = {
  compatibilityDate: "2026-08-24",
  compatibilityFlags: ["nodejs_compat"],
  workersDev: false,
  previewUrls: false,
  // Workers Paid invocation budget. Runtime admission counts Service Binding calls against this value.
  limits: { subrequests: 1000 },
  cache: { enabled: false, crossVersionCache: false },
  observability: {
    enabled: true,
    logs: { headSamplingRate: 1 },
    traces: { enabled: true, headSamplingRate: 0.05 },
  },
  exports: {
    default: exports.worker({ cache: { enabled: false } }),
    CachedAgrisProxy: exports.worker({ cache: { enabled: true } }),
  },
};

/**
 * A public deployment runs `src/public.ts` on its public hostname. Its default entrypoint is the public HTTP
 * surface; `AgrisProxy` keeps the private Service Binding entrypoint for hosts that bind this deployment.
 */
const publicSettings = {
  ...proxySettings,
  entrypoint: "./src/public.ts",
  workersDev: true,
  exports: {
    ...proxySettings.exports,
    AgrisProxy: exports.worker({ cache: { enabled: false } }),
  },
};

function subgraphs(prefix: "agris" | "agris-demo", suffix: "" | "-staging" = "") {
  return {
    MARKET: bindings.worker({ worker: `${prefix}-market${suffix}`, exportName: "BudgetedMarketSubgraph" }),
    CATALOG: bindings.worker({ worker: `${prefix}-catalog${suffix}`, exportName: "BudgetedCatalogSubgraph" }),
  };
}

export const productionWorker = defineWorker({
  ...publicSettings,
  name: "agris",
  env: {
    ...subgraphs("agris"),
    CLIENT_RATE_LIMITER: bindings.rateLimit({ namespace: "42010", simple: { limit: 60, period: 60 } }),
    GRAPHIQL: bindings.text("enabled"),
  },
});

export const stagingWorker = defineWorker({
  ...proxySettings,
  name: "agris-staging",
  entrypoint: "./src/index.ts",
  env: subgraphs("agris", "-staging"),
});

export const smokeWorker = defineWorker({
  ...proxySettings,
  name: "agris-smoke",
  entrypoint: "./src/index.ts",
  env: { ...subgraphs("agris", "-staging"), CACHE_SMOKE_MODE: bindings.text("enabled") },
});

const DEMO_DEPLOY_GUIDE_URL = "https://agris-demo.hebilicious.workers.dev/#deploy";

/**
 * The hosted demo: its own Workers, rate-limit namespaces and cache, the static site built from the repository's
 * `site/` project into `site/dist` (`wrangler.config.ts` names it), and a market freshness floor of ten minutes so a
 * crowd of visitors reaches Pearl Abyss rarely. Asset requests are answered before the Worker runs; `/graphql` and
 * `/health` always reach it.
 */
export const demoWorker = defineWorker({
  ...publicSettings,
  name: "agris-demo",
  assets: { runWorkerFirst: ["/graphql", "/health"] },
  observability: {
    enabled: true,
    logs: { headSamplingRate: 0.05 },
    traces: { enabled: true, headSamplingRate: 0.01 },
  },
  env: {
    ...subgraphs("agris-demo"),
    ASSETS: bindings.assets(),
    CLIENT_RATE_LIMITER: bindings.rateLimit({ namespace: "42021", simple: { limit: 10, period: 60 } }),
    GLOBAL_RATE_LIMITER: bindings.rateLimit({ namespace: "42022", simple: { limit: 120, period: 60 } }),
    DEMO_NOTICE: bindings.text(`Shared demo, rate-limited. Deploy your own: ${DEMO_DEPLOY_GUIDE_URL}`),
    DEPLOY_GUIDE_URL: bindings.text(DEMO_DEPLOY_GUIDE_URL),
    MARKET_CACHE_MIN_TTL_SECONDS: bindings.json(600),
    GRAPHIQL: bindings.text("enabled"),
  },
});

// The local gateway serves the catalog inline, so it binds only the local market Worker.
export const localWorker = defineWorker({
  ...proxySettings,
  name: "agris-local",
  entrypoint: "./src/local.ts",
  env: {
    MARKET: bindings.worker({ worker: "agris-market-local", exportName: "BudgetedMarketSubgraph" }),
  },
});

/** Every mode this file defines; the deployment test evaluates each one. */
export const WORKER_MODES = new Map([
  ["production", { worker: productionWorker }],
  ["staging", { worker: stagingWorker }],
  ["smoke", { worker: smokeWorker }],
  ["demo", { worker: demoWorker }],
  ["local", { worker: localWorker }],
]);

export default defineConfig(({ mode }) => {
  // API commands such as `cf workers secrets list` evaluate this file without a mode; the credentials pick the account.
  if (mode === undefined) return {};
  const selected = WORKER_MODES.get(mode);
  if (selected === undefined) throw new Error(`The Agris gateway has no mode named ${mode}.`);
  return selected;
});
