import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const CATALOG_WORKER_NAME = "agris-catalog";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./features/catalog-worker-entrypoint.test-worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-24",
        serviceBindings: {
          CATALOG: { name: CATALOG_WORKER_NAME, entrypoint: "BudgetedCatalogSubgraph" },
        },
        workers: [
          {
            name: CATALOG_WORKER_NAME,
            scriptPath: "./.artifacts/catalog-worker-runtime/.cloudflare/output/v0/workers/default/bundle/index.js",
            modules: true,
            compatibilityDate: "2026-08-24",
            compatibilityFlags: ["nodejs_compat"],
          },
        ],
      },
    }),
  ],
  test: {
    include: ["features/catalog-worker-entrypoint.worker-runtime.test.ts"],
    // Hang guards, not paces: a hung test or hook fails with a trace instead of holding the gate.
    hookTimeout: 10 * 60_000,
    maxWorkers: 1,
    retry: 0,
    testTimeout: 10 * 60_000,
  },
});
