import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath, URL } from "node:url";
import * as v from "valibot";
import { defineConfig } from "vitest/config";
import { loadWorkerConfiguration, writeWranglerConfiguration } from "@agris/tooling/cloudflare-worker-configuration";

const MARKET_WORKER_NAME = "agris-market";
const RATE_LIMITED_MARKET_WORKER_NAME = "agris-market-rate-limited";
const observedPearlAbyssSummaryKeys: string[] = [];
const pearlAbyssSummaryRequestSchema = v.strictObject({
  keyType: v.literal(0),
  searchResult: v.string(),
});
// The Workers pool reads only Wrangler files, so it gets the gateway's production mode spelled as one.
const agrisProxyConfiguration = await writeWranglerConfiguration(
  await loadWorkerConfiguration("../workers/gateway", "production"),
);
export default defineConfig({
  resolve: {
    alias: {
      "@pothos/core": fileURLToPath(
        new URL("../packages/catalog-subgraph/node_modules/@pothos/core/lib/index.js", import.meta.url),
      ),
      "@pothos/plugin-directives": fileURLToPath(
        new URL("../packages/catalog-subgraph/node_modules/@pothos/plugin-directives/lib/index.js", import.meta.url),
      ),
      "@pothos/plugin-federation": fileURLToPath(
        new URL("../packages/catalog-subgraph/node_modules/@pothos/plugin-federation/lib/index.js", import.meta.url),
      ),
    },
    dedupe: ["graphql"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: agrisProxyConfiguration },
      miniflare: {
        compatibilityDate: "2026-08-24",
        serviceBindings: {
          MARKET: { name: MARKET_WORKER_NAME, entrypoint: "BudgetedMarketSubgraph" },
          MARKET_RATE_LIMITED: { name: RATE_LIMITED_MARKET_WORKER_NAME, entrypoint: "BudgetedMarketSubgraph" },
          CATALOG: () => Response.json({ errors: [{ message: "Catalog is outside this gateway scenario" }] }),
          PA_OBSERVER: async (request) => {
            if (request.method === "DELETE") {
              observedPearlAbyssSummaryKeys.length = 0;
              return new Response(null, { status: 204 });
            }
            return Response.json({
              distinct: new Set(observedPearlAbyssSummaryKeys).size,
              total: observedPearlAbyssSummaryKeys.length,
            });
          },
        },
        workers: [
          {
            name: MARKET_WORKER_NAME,
            scriptPath: "./.artifacts/market-worker-runtime/.cloudflare/output/v0/workers/default/bundle/index.js",
            modules: true,
            compatibilityDate: "2026-08-24",
            compatibilityFlags: ["nodejs_compat"],
            bindings: { MARKET_ENVIRONMENT: "production", PA_MAX_CONCURRENT_REQUESTS: 6 },
            durableObjects: {
              PA_COORDINATOR: { className: "PearlAbyssCoordinator", useSQLite: true },
            },
            ratelimits: {
              PA_RATE_LIMITER: { namespace_id: "worker-entrypoint-market", simple: { limit: 100, period: 10 } },
            },
            outboundService: async (request) => {
              const url = new URL(request.url);
              const body = await request.text();
              const parsedBody = v.safeParse(pearlAbyssSummaryRequestSchema, JSON.parse(body));
              const itemId = parsedBody.success ? parsedBody.output.searchResult : undefined;
              const requestMatchesProductionContract =
                request.method === "POST" &&
                url.pathname === "/TradeMarket/GetWorldMarketSearchList" &&
                request.headers.get("content-type") === "application/json" &&
                request.headers.get("user-agent") === "BlackDesert" &&
                itemId !== undefined;
              if (!requestMatchesProductionContract) {
                return Response.json({ message: "Unexpected Pearl Abyss request" }, { status: 502 });
              }
              const itemIds = itemId.split(",").sort((left, right) => Number(left) - Number(right));
              observedPearlAbyssSummaryKeys.push(`${url.hostname}:${itemIds.join(",")}`);
              if (itemId === "10008") {
                return new Response("oversized", { status: 200, headers: { "Content-Length": "1048577" } });
              }
              if (itemId === "10007") throw new Error("Pearl Abyss unavailable");
              if (url.hostname === "trade.jp.playblackdesert.com") {
                throw new Error("Rejected summary batch reached the Pearl Abyss adapter");
              }
              await new Promise<void>((resolve) => setTimeout(resolve, 100));
              return Response.json({
                resultCode: 0,
                resultMsg: itemIds.map((id) => `${id}-0-377000-114184`).join("|"),
              });
            },
          },
          {
            name: RATE_LIMITED_MARKET_WORKER_NAME,
            scriptPath: "./.artifacts/market-worker-runtime/.cloudflare/output/v0/workers/default/bundle/index.js",
            modules: true,
            compatibilityDate: "2026-08-24",
            compatibilityFlags: ["nodejs_compat"],
            bindings: { MARKET_ENVIRONMENT: "production", PA_MAX_CONCURRENT_REQUESTS: 6 },
            durableObjects: {
              PA_COORDINATOR: { className: "PearlAbyssCoordinator", useSQLite: true },
            },
            ratelimits: {
              PA_RATE_LIMITER: {
                namespace_id: "worker-entrypoint-market-rate-limited",
                simple: { limit: 1, period: 10 },
              },
            },
            outboundService: async (request) => {
              const body = await request.text();
              const itemId = ["10006", "10009"].find(
                (candidate) => body === JSON.stringify({ keyType: 0, searchResult: candidate }),
              );
              if (itemId === undefined)
                return Response.json({ message: "Unexpected Pearl Abyss request" }, { status: 502 });
              return Response.json({ resultCode: 0, resultMsg: `${itemId}-0-377000-114184` });
            },
          },
        ],
      },
    }),
  ],
  test: {
    include: ["features/worker-entrypoints.worker-runtime.test.ts", "features/public-gateway.worker-runtime.test.ts"],
    // Hang guards, not paces: a hung test or hook fails with a trace instead of holding the gate.
    hookTimeout: 10 * 60_000,
    maxWorkers: 1,
    retry: 0,
    testTimeout: 10 * 60_000,
  },
});
