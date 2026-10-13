import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globals: false,
    environment: "node",
    // Hang guards, not paces: a hung test or hook fails with a trace instead of holding the gate.
    testTimeout: 10 * 60_000,
  },
});
