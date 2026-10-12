import { defineConfig, defineWorker } from "cf/config";

/**
 * The Agris catalog subgraph Worker, one mode per deployment and local runtime.
 *
 * No account is named here: `cf` deploys to the account the deployer's credentials select.
 */

const catalogSettings = {
  compatibilityDate: "2026-08-24",
  compatibilityFlags: ["nodejs_compat"],
  entrypoint: "./src/index.ts",
  workersDev: false,
  previewUrls: false,
  observability: {
    enabled: true,
    logs: { headSamplingRate: 1 },
    traces: { enabled: true, headSamplingRate: 0.05 },
  },
  env: {},
};

export const productionWorker = defineWorker({ ...catalogSettings, name: "agris-catalog" });
export const stagingWorker = defineWorker({ ...catalogSettings, name: "agris-catalog-staging" });
// The shared demo keeps sparse telemetry. The catalog is immutable, so the gateway already stores catalog-only results
// for a year and serves them stale for a day while it refreshes; the demo needs no catalog-specific floor.
export const demoWorker = defineWorker({
  ...catalogSettings,
  name: "agris-demo-catalog",
  observability: {
    enabled: true,
    logs: { headSamplingRate: 0.05 },
    traces: { enabled: true, headSamplingRate: 0.01 },
  },
});
export const localWorker = defineWorker({ ...catalogSettings, name: "agris-catalog-local" });

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
  if (selected === undefined) throw new Error(`The catalog Worker has no mode named ${mode}.`);
  return selected;
});
