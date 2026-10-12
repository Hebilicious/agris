import { defineConfig, defineWorker } from "cf/config";

/** The throwaway Worker that bundles the generated catalog search artifact for the release diagnostic. */
const artifactWorker = defineWorker({
  name: "central-market-catalog-artifact-check",
  compatibilityDate: "2026-08-31",
  compatibilityFlags: ["nodejs_compat"],
  entrypoint: "./artifact-dry-run/artifact-worker.ts",
});

/** Every mode this file defines; the deployment test evaluates each one. */
export const WORKER_MODES = new Map([["artifact", { worker: artifactWorker }]]);

export default defineConfig(({ mode }) => {
  // API commands evaluate this file without a mode; the artifact Worker is never deployed.
  if (mode === undefined) return {};
  const selected = WORKER_MODES.get(mode);
  if (selected === undefined) throw new Error(`The catalog artifact Worker has no mode named ${mode}.`);
  return selected;
});
