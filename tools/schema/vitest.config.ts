import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    dedupe: ["graphql"],
    alias: {
      "@pothos/core": resolve("../../packages/market-subgraph/node_modules/@pothos/core/lib/index.js"),
      "@pothos/plugin-dataloader": resolve(
        "../../packages/market-subgraph/node_modules/@pothos/plugin-dataloader/lib/index.js",
      ),
      "@pothos/plugin-directives": resolve(
        "../../packages/market-subgraph/node_modules/@pothos/plugin-directives/lib/index.js",
      ),
      "@pothos/plugin-federation": resolve(
        "../../packages/market-subgraph/node_modules/@pothos/plugin-federation/lib/index.js",
      ),
      graphql: resolve("../../packages/market-subgraph/node_modules/graphql"),
      "graphql/": `${resolve("../../packages/market-subgraph/node_modules/graphql")}/`,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    globals: false,
    environment: "node",
  },
});
