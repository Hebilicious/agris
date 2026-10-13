import assert from "node:assert/strict";

import { buildSchema } from "graphql";

import {
  classifyGatewayResponse,
  createGatewayRequestProtocol,
  dispatchGatewayOperation,
  type GatewayRequestProtocol,
  type NormalizedGatewayRequest,
} from "../../packages/core/src/protocol/index.ts";
import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";

const policyDocument = `
  query MarketPolicy(
    $includeHistory: Boolean!
    $includeOrderBook: Boolean!
    $skipRegistrations: Boolean!
  ) {
    market {
      summaries: items {
        ...MarketItemPolicy
      }
      queued: registrations @skip(if: $skipRegistrations) { id }
    }
  }

  fragment MarketItemPolicy on MarketItem {
    prices: listings { price }
    orders: orderBook @include(if: $includeOrderBook) { price }
    ... on MarketItem {
      historic: priceHistory @include(if: $includeHistory) { price }
    }
  }
`;

const policySchema = buildSchema(`
  type Query {
    item(id: ID, locale: ItemLocale): Item
    items(ids: [ID!]): [Item!]!
    searchItems(query: String!, locale: ItemLocale!, first: Int! = 50): ItemSearchResult!
    market: Market!
  }

  enum ItemLocale { EN FR }
  enum MarketRegion { NA EU }
  type Item {
    id: ID!
    name: String
    marketSummary(region: MarketRegion!): MarketItemSummary
  }
  type MarketItemSummary { isListed: Boolean! }
  type ItemSearchResult { items: [Item!]!, totalCount: Int! }
  type Market {
    items: [MarketItem!]!
    catalog: [MarketItem!]!
    hotItems: [MarketItem!]!
    registrations: [MarketRegistration!]!
  }
  type MarketItem {
    listings: [MarketListing!]!
    orderBook: [MarketOrder!]!
    priceHistory: [MarketPricePoint!]!
  }
  type MarketListing { price: Float! }
  type MarketOrder { price: Float! }
  type MarketPricePoint { price: Float! }
  type MarketRegistration { id: ID! }
`);

const cachedCatalogDocument = "query CachedCatalogItem($id: ID!) { item(id: $id) { id } }";

interface OperationResultCacheFixture {
  readonly executeCounts: Map<string, number>;
  readonly stored: Map<string, Response>;
  readonly requests: NormalizedGatewayRequest[];
  readonly responses: Response[];
}

interface GatewayResponseCacheWorld {
  protocol?: GatewayRequestProtocol;
  normalized?: NormalizedGatewayRequest;
  operationCache?: OperationResultCacheFixture;
}

function requireNormalized(result: Awaited<ReturnType<GatewayRequestProtocol["normalize"]>>): NormalizedGatewayRequest {
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  if (!result.ok) throw new Error("Expected a normalized gateway request");
  return result.value;
}

const steps: readonly StepDefinition<GatewayResponseCacheWorld>[] = [
  step("a production-adjacent Central Market operation-result cache", noStepArguments, async (world) => {
    world.protocol = createGatewayRequestProtocol({ schema: policySchema });
    world.operationCache = {
      executeCounts: new Map(),
      stored: new Map(),
      requests: [],
      responses: [],
    };
  }),
  step("the same catalog item is requested twice by POST", noStepArguments, async (world) => {
    await requestCatalogItems(world, [
      postRequest(cachedCatalogDocument, { id: "44195" }),
      postRequest(cachedCatalogDocument, { id: "44195" }),
    ]);
  }),
  step("both responses contain the same catalog item", noStepArguments, async (world) => {
    assert.deepEqual(await responseBodies(world), [
      { data: { item: { id: "44195" } } },
      { data: { item: { id: "44195" } } },
    ]);
  }),
  step("the Agris Proxy executes the catalog query once and stores one operation result", noStepArguments, (world) => {
    const cache = requireOperationCache(world);
    assert.equal(executionCount(cache), 1);
    assert.equal(cache.stored.size, 1);
  }),
  step("the same catalog query requests two different item IDs", noStepArguments, async (world) => {
    await requestCatalogItems(world, [
      postRequest(cachedCatalogDocument, { id: "44195" }),
      postRequest(cachedCatalogDocument, { id: "44196" }),
    ]);
  }),
  step("the responses contain their respective catalog items", noStepArguments, async (world) => {
    assert.deepEqual(await responseBodies(world), [
      { data: { item: { id: "44195" } } },
      { data: { item: { id: "44196" } } },
    ]);
  }),
  step("the Agris Proxy executes both catalog queries and stores two operation results", noStepArguments, (world) => {
    const cache = requireOperationCache(world);
    assert.equal(executionCount(cache), 2);
    assert.equal(cache.stored.size, 2);
  }),
  step("the same failing catalog query is requested twice", noStepArguments, async (world) => {
    await requestCatalogItems(world, [
      postRequest(cachedCatalogDocument, { id: "error" }),
      postRequest(cachedCatalogDocument, { id: "error" }),
    ]);
  }),
  step("both responses contain GraphQL errors with no-store caching", noStepArguments, async (world) => {
    const cache = requireOperationCache(world);
    assert.deepEqual(await responseBodies(world), [
      { errors: [{ message: "Catalog unavailable" }] },
      { errors: [{ message: "Catalog unavailable" }] },
    ]);
    assert.deepEqual(
      cache.responses.map((response) => response.headers.get("Cache-Control")),
      ["no-store", "no-store"],
    );
  }),
  step("the Agris Proxy executes the failing query twice and stores no operation result", noStepArguments, (world) => {
    const cache = requireOperationCache(world);
    assert.equal(executionCount(cache), 2);
    assert.equal(cache.stored.size, 0);
  }),
  step("the Central Market response-cache policy schema", noStepArguments, async (world) => {
    world.protocol = createGatewayRequestProtocol({ schema: policySchema });
  }),
  step(
    "a query selects aliased fields through named and inline fragments while five-second fields are skipped",
    noStepArguments,
    async (world) => {
      assert.ok(world.protocol);
      world.normalized = requireNormalized(
        await world.protocol.normalize(
          postRequest(policyDocument, {
            includeHistory: true,
            includeOrderBook: false,
            skipRegistrations: true,
          }),
        ),
      );
    },
  ),
  step(
    "its selected response policy is 60 seconds, then 70 while revalidating, with one day of stale-on-error",
    noStepArguments,
    (world) => {
      assert.deepEqual(world.normalized?.cachePolicy, {
        mode: "store",
        maxAgeSeconds: 60,
        staleWhileRevalidateSeconds: 70,
        staleIfErrorSeconds: 86_400,
      });
    },
  ),
  step("the same query includes the five-second order book field", noStepArguments, async (world) => {
    assert.ok(world.protocol);
    world.normalized = requireNormalized(
      await world.protocol.normalize(
        postRequest(policyDocument, {
          includeHistory: true,
          includeOrderBook: true,
          skipRegistrations: true,
        }),
      ),
    );
  }),
  step(
    "its selected response policy is 5 seconds, then 5 while revalidating, with one day of stale-on-error",
    noStepArguments,
    (world) => {
      assert.deepEqual(world.normalized?.cachePolicy, {
        mode: "store",
        maxAgeSeconds: 5,
        staleWhileRevalidateSeconds: 5,
        staleIfErrorSeconds: 86_400,
      });
    },
  ),
  step("a query selects no TTL-bearing coordinate", noStepArguments, async (world) => {
    assert.ok(world.protocol);
    world.normalized = requireNormalized(
      await world.protocol.normalize(postRequest("query TypeName { __typename }", {})),
    );
  }),
  step("its response policy is no-store", noStepArguments, (world) => {
    assert.deepEqual(world.normalized?.cachePolicy, { mode: "no-store" });
  }),
];

export const agrisProxyResponseCacheFeature: ExecutableFeatureManifest<GatewayResponseCacheWorld> = {
  id: "central-market-agris-proxy-response-cache",
  uri: "tests/features/agris-proxy-response-cache.feature",
  createWorld: () => ({}),
  steps,
};

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function postRequest(
  document: string,
  variables: Readonly<Record<string, unknown>>,
) {
  return {
    method: "POST",
    contentType: "application/json",
    searchParams: "",
    bodyText: JSON.stringify({ query: document, variables }),
  } as const;
}

async function requestCatalogItems(
  world: GatewayResponseCacheWorld,
  requests: readonly Parameters<GatewayRequestProtocol["normalize"]>[0][],
): Promise<void> {
  assert.ok(world.protocol);
  const cache = requireOperationCache(world);
  for (const request of requests) {
    const normalized = requireNormalized(await world.protocol.normalize(request));
    cache.requests.push(normalized);
    const response = await dispatchGatewayOperation(normalized, {
      cached: async (syntheticRequest, execute) => {
        const existing = cache.stored.get(syntheticRequest.url);
        if (existing !== undefined) return existing.clone();
        const response = await execute();
        if (response.headers.get("Cache-Control") !== "no-store") {
          cache.stored.set(syntheticRequest.url, response.clone());
        }
        return response;
      },
      execute: /* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ async (
        operation,
      ) => {
        const query = operation.execution.variables.query;
        if (typeof query === "string") {
          const locale = operation.execution.variables.locale;
          if (typeof locale !== "string") throw new TypeError("Expected a canonical Item Name search locale");
          const executionKey = `search:${locale}`;
          cache.executeCounts.set(executionKey, (cache.executeCounts.get(executionKey) ?? 0) + 1);
          const classification = classifyGatewayResponse({
            cacheStatus: "MISS",
            cachePolicy: operation.cachePolicy,
            hasGraphqlErrors: false,
            upstream: "answered",
          });
          return Response.json(
            {
              data: {
                searchItems: { items: [{ id: "16001" }, { id: "4901" }], totalCount: 4 },
              },
            },
            {
              status: classification.status,
              headers: { "Cache-Control": classification.headers["Cache-Control"] },
            },
          );
        }
        const id = operation.execution.variables.id;
        if (typeof id !== "string") throw new TypeError("Expected a canonical catalog item ID variable");
        const locale = operation.execution.variables.locale;
        const executionKey = `${id}:${typeof locale === "string" ? locale : "default"}`;
        cache.executeCounts.set(executionKey, (cache.executeCounts.get(executionKey) ?? 0) + 1);
        const hasGraphqlErrors = id === "error";
        const classification = classifyGatewayResponse({
          cacheStatus: "MISS",
          cachePolicy: operation.cachePolicy,
          hasGraphqlErrors,
          upstream: "answered",
        });
        return Response.json(
          hasGraphqlErrors
            ? { errors: [{ message: "Catalog unavailable" }] }
            : {
                data: {
                  item: typeof locale === "string" ? { id, name: `Localized Item ${locale}` } : { id },
                },
              },
          {
            status: classification.status,
            headers: { "Cache-Control": classification.headers["Cache-Control"] },
          },
        );
      },
    });
    cache.responses.push(response);
  }
}

function requireOperationCache(world: GatewayResponseCacheWorld): OperationResultCacheFixture {
  assert.ok(world.operationCache);
  return world.operationCache;
}

function executionCount(cache: OperationResultCacheFixture): number {
  return [...cache.executeCounts.values()].reduce((total, count) => total + count, 0);
}

async function responseBodies(world: GatewayResponseCacheWorld): Promise<readonly unknown[]> {
  return Promise.all(requireOperationCache(world).responses.map((response) => response.clone().json()));
}
