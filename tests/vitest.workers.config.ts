import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath, URL } from "node:url";
import { Option, Schema } from "effect";
import { defineConfig } from "vitest/config";

const MARKET_WORKER_NAME = "agris-market";
const RATE_LIMITED_MARKET_WORKER_NAME = "agris-market-rate-limited";
const UNLIMITED_MARKET_WORKER_NAME = "agris-market-unlimited";
const LOCAL_GATEWAY_WORKER_NAME = "agris-local-gateway";
const ABORTABLE_MARKET_WORKER_NAME = "agris-market-abortable";
/** The Pearl Abyss request the abortable market Worker's upstream holds until the test releases it. */
const HELD_PEARL_ABYSS_ITEM = "20001";
let releaseHeldPearlAbyssRequest = (): void => {};
let heldPearlAbyssRequest = Promise.resolve();
const observedPearlAbyssSummaryKeys: string[] = [];
const decodePearlAbyssSummaryRequest = Schema.decodeUnknownOption(
  Schema.Struct({ keyType: Schema.Literal(0), searchResult: Schema.String }),
  { onExcessProperty: "error" },
);
/** The market entrypoint as `moon run infra:bundle` bundles it for the smoke stage, named from its own directory. */
const MARKET_BUNDLE = {
  scriptPath: fileURLToPath(new URL("../.artifacts/alchemy-bundles/HostMarket/index.js", import.meta.url)),
  modulesRoot: fileURLToPath(new URL("../.artifacts/alchemy-bundles/HostMarket/", import.meta.url)),
};
/** The local gateway entrypoint as `moon run infra:bundle` bundles it, the catalog inline. */
const LOCAL_GATEWAY_BUNDLE = {
  scriptPath: fileURLToPath(new URL("../.artifacts/alchemy-bundles/HostLocalGateway/local.js", import.meta.url)),
  modulesRoot: fileURLToPath(new URL("../.artifacts/alchemy-bundles/HostLocalGateway/", import.meta.url)),
};
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
      // The public gateway under test, with the private `AgrisProxy` entrypoint beside it and a client rate limiter.
      main: "../apps/gateway/src/public.ts",
      miniflare: {
        compatibilityDate: "2026-08-24",
        compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
        bindings: { GRAPHIQL: "enabled" },
        ratelimits: { CLIENT_RATE_LIMITER: { namespace_id: "42010", simple: { limit: 60, period: 60 } } },
        serviceBindings: {
          MARKET: { name: MARKET_WORKER_NAME, entrypoint: "BudgetedMarketSubgraph" },
          MARKET_RATE_LIMITED: { name: RATE_LIMITED_MARKET_WORKER_NAME, entrypoint: "BudgetedMarketSubgraph" },
          MARKET_UNLIMITED: { name: UNLIMITED_MARKET_WORKER_NAME, entrypoint: "BudgetedMarketSubgraph" },
          LOCAL_GATEWAY: { name: LOCAL_GATEWAY_WORKER_NAME },
          MARKET_ABORTABLE: { name: ABORTABLE_MARKET_WORKER_NAME, entrypoint: "BudgetedMarketSubgraph" },
          // DELETE makes the abortable market Worker hold its next request for HELD_PEARL_ABYSS_ITEM; POST releases it.
          PA_HOLD: async (request) => {
            if (request.method === "DELETE") {
              heldPearlAbyssRequest = new Promise<void>((resolve) => {
                releaseHeldPearlAbyssRequest = resolve;
              });
            } else {
              releaseHeldPearlAbyssRequest();
            }
            return new Response(null, { status: 204 });
          },
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
            // The local gateway as a host binds it: a raised subrequest budget and a cache setting of its own.
            name: LOCAL_GATEWAY_WORKER_NAME,
            ...LOCAL_GATEWAY_BUNDLE,
            modules: true,
            compatibilityDate: "2026-08-24",
            compatibilityFlags: ["nodejs_compat"],
            bindings: { SUBREQUEST_LIMIT: "3", CACHE_NEVER_STORED: "Item.marketSummary" },
            serviceBindings: { MARKET: { name: MARKET_WORKER_NAME, entrypoint: "BudgetedMarketSubgraph" } },
          },
          {
            name: MARKET_WORKER_NAME,
            ...MARKET_BUNDLE,
            modules: true,
            compatibilityDate: "2026-08-24",
            compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
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
              const itemId = Option.getOrUndefined(decodePearlAbyssSummaryRequest(JSON.parse(body)))?.searchResult;
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
            ...MARKET_BUNDLE,
            modules: true,
            compatibilityDate: "2026-08-24",
            compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
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
          {
            // A deployment that binds no Pearl Abyss rate limiter and no concurrency setting: it limits neither.
            name: UNLIMITED_MARKET_WORKER_NAME,
            ...MARKET_BUNDLE,
            modules: true,
            compatibilityDate: "2026-08-24",
            compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
            bindings: { MARKET_ENVIRONMENT: "production" },
            durableObjects: {
              PA_COORDINATOR: { className: "PearlAbyssCoordinator", useSQLite: true },
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
          {
            // A deployment whose coordinators run one Pearl Abyss request at once, and whose upstream holds one item.
            name: ABORTABLE_MARKET_WORKER_NAME,
            ...MARKET_BUNDLE,
            modules: true,
            compatibilityDate: "2026-08-24",
            compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
            bindings: { MARKET_ENVIRONMENT: "production", PA_MAX_CONCURRENT_REQUESTS: 1 },
            durableObjects: {
              PA_COORDINATOR: { className: "PearlAbyssCoordinator", useSQLite: true },
            },
            outboundService: async (request) => {
              const itemId = Option.getOrUndefined(
                decodePearlAbyssSummaryRequest(JSON.parse(await request.text())),
              )?.searchResult;
              if (itemId === undefined) {
                return Response.json({ message: "Unexpected Pearl Abyss request" }, { status: 502 });
              }
              observedPearlAbyssSummaryKeys.push(`${new URL(request.url).hostname}:${itemId}`);
              if (itemId === HELD_PEARL_ABYSS_ITEM) await heldPearlAbyssRequest;
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
