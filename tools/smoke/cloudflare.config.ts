import { bindings, defineConfig, defineWorker } from "cf/config";

/** A disposable local caller bound remotely to a private deployed Agris gateway. */

function callerWorker(name: string, proxy: string) {
  return defineWorker({
    name,
    compatibilityDate: "2026-08-24",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "./caller/src/index.ts",
    workersDev: false,
    previewUrls: false,
    env: { AGRIS_PROXY: bindings.worker({ worker: proxy, dev: { remote: true } }) },
  });
}

/** Calls the private cache-smoke variant of the Agris gateway. */
export const remoteWorker = callerWorker("agris-smoke-caller", "agris-smoke");
/** Calls the private staging Agris gateway. */
export const stagingRemoteWorker = callerWorker("agris-staging-caller", "agris-staging");

/** Every mode this file defines; the deployment test evaluates each one. */
export const WORKER_MODES = new Map([
  ["remote", { worker: remoteWorker }],
  ["staging-remote", { worker: stagingRemoteWorker }],
]);

export default defineConfig(({ mode }) => {
  // API commands evaluate this file without a mode; the caller is never deployed.
  if (mode === undefined) return {};
  const selected = WORKER_MODES.get(mode);
  if (selected === undefined) throw new Error(`The smoke caller has no mode named ${mode}.`);
  return selected;
});
