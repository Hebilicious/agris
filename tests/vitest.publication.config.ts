import { defineConfig } from "vitest/config";

// Publication evidence calls deployed Workers, so it runs only on request and never beside the local suites.
export default defineConfig({
  test: {
    include: ["features/**/*.publication.test.ts"],
    environment: "node",
    // Hang guards, not paces: a hung test or hook fails with a trace instead of holding the run.
    hookTimeout: 10 * 60_000,
    maxWorkers: 1,
    pool: "forks",
    retry: 0,
    testTimeout: 10 * 60_000,
  },
});
