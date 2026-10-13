import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import { TEST_WORKERS } from "./test-parallelism.ts";

// The subgraph packages and this project each link Pothos and graphql; one instance of each keeps the schema builders
// and the gateway agreeing on the types they exchange.
export default defineConfig({
  resolve: {
    alias: {
      "@pothos/core": fileURLToPath(
        new URL("../packages/market-subgraph/node_modules/@pothos/core/lib/index.js", import.meta.url),
      ),
      "@pothos/plugin-dataloader": fileURLToPath(
        new URL("../packages/market-subgraph/node_modules/@pothos/plugin-dataloader/lib/index.js", import.meta.url),
      ),
      "@pothos/plugin-directives": fileURLToPath(
        new URL("../packages/market-subgraph/node_modules/@pothos/plugin-directives/lib/index.js", import.meta.url),
      ),
      "@pothos/plugin-federation": fileURLToPath(
        new URL("../packages/market-subgraph/node_modules/@pothos/plugin-federation/lib/index.js", import.meta.url),
      ),
    },
    dedupe: ["graphql"],
  },
  test: {
    execArgv: ["--max-old-space-size=768"],
    include: ["features/**/*.integration.test.ts"],
    environment: "node",
    // Hang guards, not paces: a hung test or hook fails with a trace instead of holding the run.
    hookTimeout: 10 * 60_000,
    maxWorkers: TEST_WORKERS,
    pool: "forks",
    retry: 0,
    testTimeout: 10 * 60_000,
  },
});
