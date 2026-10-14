import assert from "node:assert/strict";
import { env, createExecutionContext } from "cloudflare:test";
import { withExports } from "cloudflare:workers";
import type { GatewayPlugin } from "@graphql-hive/gateway-runtime";
import { Kind, parse, valueFromASTUntyped } from "graphql";
import { Option, Schema } from "effect";
import {
  executeAgrisProxy,
  agrisProxyWorker,
  serviceBindingPort,
  type AgrisProxyExecutionProps,
  type AgrisProxyRuntimeEnv,
} from "../../apps/gateway/src/index.ts";

import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";
import { openStruct, STRICT } from "../support/schema.ts";

const GRAPHQL_URL = "https://agris-proxy.internal/graphql";
const MARKET_ITEM_QUERY = `
  query WorkerEntrypoints($region: MarketRegion!, $ids: [ID!]!, $locale: ItemLocale!) {
    market(region: $region, locale: $locale) {
      region
      locale
      observedAt
      items(ids: $ids) {
        item { id locale }
        isListed
        basePrice
        currentStock
        totalTrades
      }
    }
  }
`;

interface WorkerEntrypointsWorld {
  readonly cache: Map<string, Response>;
  gatewayResponses?: readonly Response[];
  gatewayBodies?: readonly unknown[];
  summaryBudgetBody?: SummaryBudgetResponse;
  summaryBudgetPearlAbyssRequests?: { readonly distinct: number; readonly total: number };
  recordedOperations?: readonly string[];
}

const summaryValueSchema = Schema.NullOr(
  Schema.Struct({
    region: Schema.String,
    isListed: Schema.Boolean,
    basePrice: Schema.NullOr(Schema.Number),
  }),
);
const summaryBudgetItemSchema = Schema.Struct({
  id: Schema.String,
  locale: Schema.Literal("EN"),
  batch1: summaryValueSchema,
  batch2: summaryValueSchema,
  batch3: summaryValueSchema,
  batch4: summaryValueSchema,
  batch5: summaryValueSchema,
  batch6: summaryValueSchema,
  batch7: summaryValueSchema,
});
const summaryBudgetResponseSchema = Schema.Struct({
  data: Schema.Struct({ items: Schema.Array(summaryBudgetItemSchema) }),
  errors: Schema.optionalKey(
    Schema.Array(
      openStruct({
        extensions: openStruct({ code: Schema.String }),
        path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
      }),
    ),
  ),
});
const catalogPlanRequestSchema = Schema.Struct({
  query: Schema.String,
  variables: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  ),
});
const decodeSummaryBudgetResponse = Schema.decodeUnknownSync(summaryBudgetResponseSchema, STRICT);
const decodeCatalogPlanRequest = Schema.decodeUnknownSync(catalogPlanRequestSchema);
const decodeCatalogPlanItemIds = Schema.decodeUnknownOption(Schema.Array(Schema.String));
const decodePearlAbyssObservation = Schema.decodeUnknownSync(
  Schema.Struct({ distinct: Schema.Number, total: Schema.Number }),
  STRICT,
);

type SummaryBudgetResponse = typeof summaryBudgetResponseSchema.Type;
type SummaryBudgetItem = typeof summaryBudgetItemSchema.Type;

const steps: readonly StepDefinition<WorkerEntrypointsWorld>[] = [
  step("a cold operation-result cache around the Agris Proxy Worker entrypoint", noStepArguments, (world) => {
    world.cache.clear();
  }),
  step(
    "the same cacheable market summary query is sent through the Agris Proxy Worker twice",
    noStepArguments,
    async (world) => {
      const gatewayEnv: AgrisProxyRuntimeEnv = {
        MARKET: serviceBindingPort(env.MARKET),
        CATALOG: serviceBindingPort(env.CATALOG),
      };
      const cachedAgrisProxy = createCachedAgrisProxyExport(world.cache, gatewayEnv);
      const responses = [
        await executeAgrisProxyEntrypoint(gatewayEnv, cachedAgrisProxy),
        await executeAgrisProxyEntrypoint(gatewayEnv, cachedAgrisProxy),
      ];
      world.gatewayResponses = responses;
      world.gatewayBodies = await Promise.all(responses.map((response) => response.clone().json()));
    },
  ),
  step("both Agris Proxy responses contain the Pearl Abyss summary", noStepArguments, (world) => {
    assert.ok(world.gatewayResponses);
    assert.ok(world.gatewayBodies);
    assert.deepEqual(
      world.gatewayResponses.map((response) => response.status),
      [200, 200],
    );
    for (const body of world.gatewayBodies) {
      const response = requiredRecord(body);
      assert.equal(response.errors, undefined, JSON.stringify(response));
      const data = requiredRecord(response.data);
      const market = requiredRecord(data.market);
      assert.equal(market.region, "NA");
      assert.equal(market.locale, "EN");
      assert.match(requiredString(market.observedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
      assert.deepEqual(market.items, [
        {
          item: { id: "10006", locale: "EN" },
          isListed: true,
          basePrice: 377_000,
          currentStock: 0,
          totalTrades: 114_184,
        },
      ]);
    }
  }),
  step("the first Agris Proxy response is a live cache miss", noStepArguments, (world) => {
    assertAgrisProxyCacheEvidence(requiredAgrisProxyResponse(world, 0), {
      cacheStatus: "MISS",
      source: "live",
      refresh: "succeeded",
    });
  }),
  step("the second Agris Proxy response is a fresh cache hit", noStepArguments, (world) => {
    assertAgrisProxyCacheEvidence(requiredAgrisProxyResponse(world, 1), {
      cacheStatus: "HIT",
      source: "cache-fresh",
      refresh: "not-attempted",
    });
  }),
  step(
    "the real Agris Proxy queries a market item while Pearl Abyss is unavailable",
    noStepArguments,
    async (world) => {
      const gatewayEnv: AgrisProxyRuntimeEnv = {
        MARKET: serviceBindingPort(env.MARKET),
        CATALOG: serviceBindingPort(env.CATALOG),
      };
      const response = await executeAgrisProxyEntrypoint(
        gatewayEnv,
        createCachedAgrisProxyExport(world.cache, gatewayEnv),
        gatewayRequest("10007"),
      );
      world.gatewayResponses = [response];
      world.gatewayBodies = [await response.clone().json()];
    },
  ),
  step("the gateway returns an uncached HTTP 503 refresh failure", noStepArguments, (world) => {
    const response = requiredAgrisProxyResponse(world, 0);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Central-Market-Source"), "live");
    assert.equal(response.headers.get("X-Central-Market-Refresh"), "failed");
    assert.equal(response.headers.get("Content-Type"), "application/graphql-response+json; charset=utf-8");
    const body = requiredRecord(world.gatewayBodies?.[0]);
    assert.equal(body.data, null);
    assert.ok(Array.isArray(body.errors));
    assert.equal(requiredRecord(body.errors[0]).message, "Central Market subgraph unavailable");
  }),
  step(
    "one Agris operation concurrently requests seven regional market-summary keys",
    noStepArguments,
    async (world) => {
      await resetPearlAbyssObservation();
      world.summaryBudgetBody = await executeSummaryBudgetOperation(
        ["NA", "EU", "ASIA", "MENA", "KR", "RU", "JP"],
        [11_006],
      );
      world.summaryBudgetPearlAbyssRequests = await readPearlAbyssObservation();
    },
  ),
  step("six market-summary paths return data and the seventh is nullable", noStepArguments, (world) => {
    const summaries = summaryBudgetResults(world);
    assert.equal(summaries.length, 1);
    const summary = summaries[0];
    assert.ok(summary);
    assert.ok(
      [summary.batch1, summary.batch2, summary.batch3, summary.batch4, summary.batch5, summary.batch6].every(
        (value) => value !== null,
      ),
      JSON.stringify(world.summaryBudgetBody),
    );
    assert.equal(summary.batch7, null);
  }),
  step(
    "the real Agris Proxy queries two market items through a market Worker that binds neither PA_RATE_LIMITER nor PA_MAX_CONCURRENT_REQUESTS",
    noStepArguments,
    async (world) => {
      const gatewayEnv: AgrisProxyRuntimeEnv = {
        MARKET: serviceBindingPort(unlimitedMarket()),
        CATALOG: serviceBindingPort(env.CATALOG),
      };
      const cachedAgrisProxy = createCachedAgrisProxyExport(new Map(), gatewayEnv);
      const responses = [
        await executeAgrisProxyEntrypoint(gatewayEnv, cachedAgrisProxy, gatewayRequest("10006")),
        await executeAgrisProxyEntrypoint(gatewayEnv, cachedAgrisProxy, gatewayRequest("10009")),
      ];
      world.gatewayResponses = responses;
      world.gatewayBodies = await Promise.all(responses.map((response) => response.clone().json()));
    },
  ),
  step("both market items come back with their Pearl Abyss summary", noStepArguments, (world) => {
    assert.deepEqual(
      world.gatewayResponses?.map((response) => response.status),
      [200, 200],
      JSON.stringify(world.gatewayBodies),
    );
    const basePrices = (world.gatewayBodies ?? []).map((body) => {
      const response = requiredRecord(body);
      assert.equal(response.errors, undefined, JSON.stringify(response));
      const market = requiredRecord(requiredRecord(response.data).market);
      assert.ok(Array.isArray(market.items));
      return requiredRecord(market.items[0]).basePrice;
    });
    assert.deepEqual(basePrices, [377_000, 377_000]);
  }),
  step(
    "the real Agris Proxy executes a market item query with a plugin that records each operation",
    noStepArguments,
    async (world) => {
      const recorded: string[] = [];
      const recorder: GatewayPlugin = {
        onExecute({ args }) {
          recorded.push(args.operationName ?? "(anonymous)");
        },
      };
      const gatewayEnv: AgrisProxyRuntimeEnv = {
        MARKET: serviceBindingPort(env.MARKET),
        CATALOG: serviceBindingPort(env.CATALOG),
        plugins: [recorder],
      };
      const response = await executeAgrisProxyEntrypoint(
        gatewayEnv,
        createCachedAgrisProxyExport(new Map(), gatewayEnv),
      );
      world.gatewayResponses = [response];
      world.gatewayBodies = [await response.clone().json()];
      world.recordedOperations = recorded;
    },
  ),
  step("the plugin recorded the operation WorkerEntrypoints once", noStepArguments, (world) => {
    assert.deepEqual(world.recordedOperations, ["WorkerEntrypoints"]);
  }),
  step("the response still carries the Pearl Abyss summary", noStepArguments, (world) => {
    assert.equal(requiredAgrisProxyResponse(world, 0).status, 200);
    const response = requiredRecord(world.gatewayBodies?.[0]);
    assert.equal(response.errors, undefined, JSON.stringify(response));
    const market = requiredRecord(requiredRecord(response.data).market);
    assert.ok(Array.isArray(market.items));
    assert.equal(requiredRecord(market.items[0]).basePrice, 377_000);
  }),
  step(
    "the local gateway reads an item's NA and EU market summaries with SUBREQUEST_LIMIT 3 and CACHE_NEVER_STORED naming Item.marketSummary",
    noStepArguments,
    async (world) => {
      const response = await localGateway().fetch(
        new Request(GRAPHQL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query:
              'query LocalGateway { item(id: "10006", locale: EN) { na: marketSummary(region: NA) { basePrice } eu: marketSummary(region: EU) { basePrice } } }',
          }),
        }),
      );
      world.gatewayResponses = [response];
      world.gatewayBodies = [await response.clone().json()];
    },
  ),
  step("one summary has data and the other reports QUERY_BUDGET_EXCEEDED", noStepArguments, (world) => {
    assert.equal(requiredAgrisProxyResponse(world, 0).status, 200);
    const body = requiredRecord(world.gatewayBodies?.[0]);
    const item = requiredRecord(requiredRecord(body.data).item);
    const summaries = [item.na, item.eu];
    assert.equal(summaries.filter((summary) => summary === null).length, 1, JSON.stringify(body));
    assert.ok(summaries.some((summary) => summary !== null && requiredRecord(summary).basePrice === 377_000));
    assert.ok(Array.isArray(body.errors));
    assert.deepEqual(
      body.errors.map((error) => requiredRecord(requiredRecord(error).extensions).code),
      ["QUERY_BUDGET_EXCEEDED"],
    );
  }),
  step("the answer is never stored", noStepArguments, (world) => {
    assert.equal(requiredAgrisProxyResponse(world, 0).headers.get("Cache-Control"), "no-store");
  }),
  step("the rejected path reports QUERY_BUDGET_EXCEEDED without reaching Pearl Abyss", noStepArguments, (world) => {
    const body = world.summaryBudgetBody;
    assert.ok(body?.errors);
    assert.equal(body.errors.length, 1);
    const error = body.errors[0];
    assert.ok(error);
    assert.equal(error.extensions.code, "QUERY_BUDGET_EXCEEDED");
    assert.deepEqual(error.path, ["items", "batch7"]);
    assert.deepEqual(world.summaryBudgetPearlAbyssRequests, { distinct: 6, total: 6 });
  }),
];

export const centralMarketWorkerEntrypointsFeature: ExecutableFeatureManifest<WorkerEntrypointsWorld> = {
  id: "central-market-worker-entrypoints",
  uri: "tests/features/worker-entrypoints.feature",
  createWorld: () => ({ cache: new Map() }),
  steps,
};

interface CachedAgrisProxyExport {
  (options: { readonly props: AgrisProxyExecutionProps }): {
    readonly fetch: (request: Request) => Promise<Response>;
  };
}

function createCachedAgrisProxyExport(
  cache: Map<string, Response>,
  gatewayEnv: AgrisProxyRuntimeEnv,
): CachedAgrisProxyExport {
  return ({ props }) => ({
    fetch: async (request) => {
      const existing = cache.get(request.url);
      if (existing !== undefined) return withCacheStatus(existing.clone(), "HIT");
      const response = await executeAgrisProxy(gatewayEnv, props);
      if (response.headers.get("Cache-Control") !== "no-store") cache.set(request.url, response.clone());
      return withCacheStatus(response, "MISS");
    },
  });
}

async function executeAgrisProxyEntrypoint(
  gatewayEnv: AgrisProxyRuntimeEnv,
  cachedAgrisProxy: CachedAgrisProxyExport,
  request = gatewayRequest(),
): Promise<Response> {
  const result: unknown = withExports({ CachedAgrisProxy: cachedAgrisProxy }, () =>
    agrisProxyWorker.fetch(request, gatewayEnv, createExecutionContext()),
  );
  const response: unknown = await Promise.resolve(result);
  if (!(response instanceof Response)) throw new TypeError("Agris Proxy Worker entrypoint did not return a Response");
  return response;
}

function withCacheStatus(response: Response, cacheStatus: "HIT" | "MISS"): Response {
  const headers = new Headers(response.headers);
  headers.set("Cf-Cache-Status", cacheStatus);
  return new Response(response.body, { status: response.status, headers });
}

function gatewayRequest(itemId = "10006"): Request {
  return new Request(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: MARKET_ITEM_QUERY,
      variables: { region: "NA", ids: [itemId], locale: "EN" },
    }),
  });
}

async function executeSummaryBudgetOperation(
  regions: readonly string[],
  itemIds: readonly number[],
): Promise<SummaryBudgetResponse> {
  const gatewayEnv: AgrisProxyRuntimeEnv = {
    MARKET: serviceBindingPort(env.MARKET),
    CATALOG: { fetch: summaryBudgetCatalogFetch },
  };
  const selections = regions
    .map(
      (region, index) => `
        batch${index + 1}: marketSummary(region: ${region}) {
          region
          isListed
          basePrice
        }
      `,
    )
    .join("\n");
  const response = await executeAgrisProxyEntrypoint(
    gatewayEnv,
    createCachedAgrisProxyExport(new Map(), gatewayEnv),
    new Request(GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query SummaryOperationBudget { items(ids: [${itemIds.map((itemId) => `"${itemId}"`).join(", ")}], locale: EN) { id locale ${selections} } }`,
      }),
    }),
  );
  assert.equal(response.status, 200);
  return decodeSummaryBudgetResponse(await response.json());
}

async function summaryBudgetCatalogFetch(request: Request): Promise<Response> {
  const { query, variables = {} } = decodeCatalogPlanRequest(await request.json());
  const data: Record<string, readonly { readonly __typename: "Item"; readonly id: string; readonly locale: "EN" }[]> =
    {};
  const document = parse(query);
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    for (const selection of definition.selectionSet.selections) {
      if (selection.kind !== Kind.FIELD || selection.name.value !== "items") continue;
      const alias = selection.alias?.value ?? selection.name.value;
      const idsArgument = selection.arguments?.find((argument) => argument.name.value === "ids");
      const ids = Option.getOrUndefined(
        decodeCatalogPlanItemIds(
          idsArgument === undefined ? undefined : valueFromASTUntyped(idsArgument.value, variables),
        ),
      );
      if (ids !== undefined) {
        data[alias] = ids.map((id) => ({ __typename: "Item", id, locale: "EN" }));
      }
    }
  }
  if (Object.keys(data).length === 0) {
    return Response.json({ errors: [{ message: "Unexpected Catalog summary-budget query plan" }] }, { status: 502 });
  }
  return Response.json({ data });
}

function summaryBudgetResults(world: WorkerEntrypointsWorld): readonly SummaryBudgetItem[] {
  assert.ok(world.summaryBudgetBody);
  return world.summaryBudgetBody.data.items;
}

async function resetPearlAbyssObservation(): Promise<void> {
  const response = await pearlAbyssObserver().fetch("https://pa-observer.internal/", { method: "DELETE" });
  assert.equal(response.status, 204);
}

async function readPearlAbyssObservation(): Promise<{ readonly distinct: number; readonly total: number }> {
  const response = await pearlAbyssObserver().fetch("https://pa-observer.internal/");
  assert.equal(response.status, 200);
  return decodePearlAbyssObservation(await response.json());
}

interface TestBinding {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

function unlimitedMarket(): unknown {
  // SAFETY: The Vitest Miniflare configuration owns and installs the MARKET_UNLIMITED service binding for this runtime.
  return (env as Cloudflare.Env & { readonly MARKET_UNLIMITED: unknown }).MARKET_UNLIMITED;
}

function localGateway(): Fetcher {
  // SAFETY: The Vitest Miniflare configuration owns and installs the LOCAL_GATEWAY service binding for this runtime.
  return (env as Cloudflare.Env & { readonly LOCAL_GATEWAY: Fetcher }).LOCAL_GATEWAY;
}

function pearlAbyssObserver(): TestBinding {
  // SAFETY: The Vitest Miniflare configuration owns and installs the PA_OBSERVER service binding for this test runtime.
  return (env as Cloudflare.Env & { readonly PA_OBSERVER: TestBinding }).PA_OBSERVER;
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function requiredRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  // SAFETY: The owning guard or fixture establishes value conforms to Readonly<Record<string, unknown>> before this statement uses it.
  return value as Readonly<Record<string, unknown>>;
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function requiredString(
  value: unknown,
): string {
  if (typeof value !== "string") throw new TypeError("Expected a string value");
  return value;
}

function requiredAgrisProxyResponse(world: WorkerEntrypointsWorld, index: number): Response {
  const response = world.gatewayResponses?.[index];
  assert.ok(response);
  return response;
}

function assertAgrisProxyCacheEvidence(
  response: Response,
  expected: { readonly cacheStatus: string; readonly source: string; readonly refresh: string },
): void {
  assert.equal(response.headers.get("Cf-Cache-Status"), expected.cacheStatus);
  assert.equal(response.headers.get("X-Central-Market-Source"), expected.source);
  assert.equal(response.headers.get("X-Central-Market-Refresh"), expected.refresh);
  assert.equal(
    response.headers.get("Cache-Control"),
    "public, max-age=60, stale-while-revalidate=70, stale-if-error=86400",
  );
}
