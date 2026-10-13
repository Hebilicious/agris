import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath, URL } from "node:url";
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
            // The catalog entrypoint as `moon run infra:bundle` bundles it for the smoke stage.
            scriptPath: fileURLToPath(new URL("../.artifacts/alchemy-bundles/HostCatalog/index.js", import.meta.url)),
            modulesRoot: fileURLToPath(new URL("../.artifacts/alchemy-bundles/HostCatalog/", import.meta.url)),
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
