import { bindings, defineConfig, defineWorker, exports } from "cf/config";

/**
 * The Agris market subgraph Worker, one mode per deployment and local runtime.
 *
 * No account is named here: `cf` deploys to the account the deployer's credentials select. Rate-limit namespace IDs
 * are scoped to the account, so a host that deploys these Workers beside other rate-limited Workers picks its own.
 */

interface MarketWorkerLimits {
  /** Global active Pearl Abyss request limit per upstream host. */
  readonly maxConcurrentRequests: number;
  /** Burst backstop on Pearl Abyss calls. */
  readonly rateLimit: { readonly limit: number; readonly period: 10 | 60 };
  /** The share of invocations whose logs and traces are kept. */
  readonly sampling: { readonly logs: number; readonly traces: number };
}

const STANDARD_LIMITS: MarketWorkerLimits = {
  maxConcurrentRequests: 6,
  rateLimit: { limit: 100, period: 10 },
  sampling: { logs: 1, traces: 0.05 },
};

// The shared demo protects Pearl Abyss first: two calls at a time, at most twenty a minute, and sparse telemetry.
const DEMO_LIMITS: MarketWorkerLimits = {
  maxConcurrentRequests: 2,
  rateLimit: { limit: 20, period: 60 },
  sampling: { logs: 0.05, traces: 0.01 },
};

function marketWorker(
  name: string,
  environment: "production" | "staging" | "demo" | "local",
  rateLimitNamespace: string,
  limits: MarketWorkerLimits = STANDARD_LIMITS,
) {
  return defineWorker({
    name,
    compatibilityDate: "2026-08-24",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "./src/index.ts",
    workersDev: false,
    previewUrls: false,
    // Workers Paid invocation budget. The market coordinator admits Pearl Abyss fetches against this value.
    limits: { subrequests: 1000 },
    observability: {
      enabled: true,
      logs: { headSamplingRate: limits.sampling.logs },
      traces: { enabled: true, headSamplingRate: limits.sampling.traces },
    },
    env: {
      MARKET_ENVIRONMENT: bindings.text(environment),
      // Global active Pearl Abyss request limit per upstream host. Extra distinct work waits FIFO; matching pending
      // work is shared.
      PA_MAX_CONCURRENT_REQUESTS: bindings.json(limits.maxConcurrentRequests),
      PA_COORDINATOR: bindings.durableObject({ worker: name, exportName: "PearlAbyssCoordinator" }),
      // Burst backstop. Active concurrency is controlled separately by PA_MAX_CONCURRENT_REQUESTS.
      PA_RATE_LIMITER: bindings.rateLimit({ namespace: rateLimitNamespace, simple: limits.rateLimit }),
    },
    exports: {
      default: exports.worker({ cache: { enabled: false } }),
      BudgetedMarketSubgraph: exports.worker({ cache: { enabled: false } }),
      PearlAbyssCoordinator: exports.durableObject({ storage: "sqlite" }),
    },
  });
}

export const productionWorker = marketWorker("agris-market", "production", "42003");
export const stagingWorker = marketWorker("agris-market-staging", "staging", "42002");
export const demoWorker = marketWorker("agris-demo-market", "demo", "42020", DEMO_LIMITS);
export const localWorker = marketWorker("agris-market-local", "local", "42001");

/** Every mode this file defines; the deployment test evaluates each one. */
export const WORKER_MODES = new Map([
  ["production", { worker: productionWorker }],
  ["staging", { worker: stagingWorker }],
  ["demo", { worker: demoWorker }],
  ["local", { worker: localWorker }],
]);

export default defineConfig(({ mode }) => {
  // API commands such as `cf workers secrets list` evaluate this file without a mode; the credentials pick the account.
  if (mode === undefined) return {};
  const selected = WORKER_MODES.get(mode);
  if (selected === undefined) throw new Error(`The market Worker has no mode named ${mode}.`);
  return selected;
});
