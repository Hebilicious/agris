import { defineConfig } from "vitest/config";
import { TEST_WORKERS } from "./test-parallelism.ts";

export default defineConfig({
  test: {
    execArgv: ["--max-old-space-size=768"],
    include: ["features/**/*.headless.test.ts"],
    environment: "node",
    server: {
      deps: {
        external: [/packages\/catalog-subgraph\/dist\//],
      },
    },
    // Hang guards, not paces: a hung test or hook fails with a trace instead of holding the run.
    hookTimeout: 10 * 60_000,
    maxWorkers: TEST_WORKERS,
    pool: "forks",
    retry: 0,
    testTimeout: 10 * 60_000,
  },
});
