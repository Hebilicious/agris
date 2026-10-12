import assert from "node:assert/strict";

import {
  createCentralMarketGraphTestRuntime,
  type CentralMarketGraphTestRuntime,
} from "../../packages/core/src/testing.ts";
import type { MarketSummary } from "../../packages/market-subgraph/src/index.ts";
import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";

const observedAt = "2026-08-31T04:05:06.000Z";

interface FederatedItemMarketSummaryWorld {
  runtime?: CentralMarketGraphTestRuntime;
  requestedIds?: readonly number[];
  response?: unknown;
}

const steps: readonly StepDefinition<FederatedItemMarketSummaryWorld>[] = [
  step("100 catalog Items include listed market facts except for omitted item 30042", noStepArguments, (world) => {
    const uniqueIds = itemIds(30_000, 100);
    world.requestedIds = [...uniqueIds.slice(0, 50), 30_007, ...uniqueIds.slice(50)];
    world.runtime = runtime(uniqueIds.filter((itemId) => itemId !== 30_042));
  }),
  step("101 catalog Items have available market facts", noStepArguments, (world) => {
    const uniqueIds = itemIds(40_000, 101);
    world.requestedIds = uniqueIds;
    world.runtime = runtime(uniqueIds);
  }),
  step(
    "an authorized caller requests their EU market summaries with item 30007 duplicated through Agris Proxy",
    noStepArguments,
    executeMarketSummaryQuery,
  ),
  step(
    "an authorized caller requests all of their EU market summaries through Agris Proxy",
    noStepArguments,
    executeMarketSummaryQuery,
  ),
  step(
    "all Item siblings survive in requested order with one timestamped EU summary each",
    noStepArguments,
    (world) => {
      const items = responseItems(world);
      assert.deepEqual(
        items.map((item) => requiredString(item, "id")),
        world.requestedIds?.map(String),
      );
      assert.deepEqual(
        items.map((item) => requiredString(item, "locale")),
        Array.from({ length: 101 }, () => "EN"),
      );
      for (const item of items) {
        const summary = requiredRecord(item.marketSummary);
        assert.equal(requiredString(summary, "region"), "EU");
        assert.equal(requiredString(summary, "observedAt"), observedAt);
      }
    },
  ),
  step(
    "both copies of item 30007 share its listed facts while item 30042 is explicitly unlisted",
    noStepArguments,
    (world) => {
      const items = responseItems(world);
      const duplicateSummaries = items
        .filter((item) => requiredString(item, "id") === "30007")
        .map((item) => item.marketSummary);
      assert.deepEqual(duplicateSummaries, [listedSummary(30_007), listedSummary(30_007)]);
      const omitted = items.find((item) => requiredString(item, "id") === "30042");
      assert.ok(omitted);
      assert.deepEqual(omitted.marketSummary, {
        region: "EU",
        observedAt,
        isListed: false,
        basePrice: null,
        currentStock: null,
        totalTrades: null,
      });
    },
  ),
  step(
    "Pearl Abyss receives one ordered summary batch containing the 100 unique Item IDs",
    noStepArguments,
    (world) => {
      assert.deepEqual(world.runtime?.observedWork().marketSummaryBatches, [itemIds(30_000, 100)]);
    },
  ),
  step(
    "every Item identity survives with a null market summary and QUERY_BUDGET_EXCEEDED",
    noStepArguments,
    (world) => {
      const response = requiredRecord(world.response);
      const items = responseItems(world);
      assert.deepEqual(
        items.map((item) => ({
          id: requiredString(item, "id"),
          locale: requiredString(item, "locale"),
          marketSummary: item.marketSummary,
        })),
        itemIds(40_000, 101).map((itemId) => ({ id: String(itemId), locale: "EN", marketSummary: null })),
      );
      assert.ok(Array.isArray(response.errors));
      assert.equal(response.errors.length, 101);
      for (const error of response.errors) {
        const extensions = requiredRecord(requiredRecord(error).extensions);
        assert.equal(requiredString(extensions, "code"), "QUERY_BUDGET_EXCEEDED");
      }
    },
  ),
  step("Pearl Abyss receives no summary request", noStepArguments, (world) => {
    assert.deepEqual(world.runtime?.observedWork().marketSummaryBatches, []);
  }),
];

export const federatedItemMarketSummaryFeature: ExecutableFeatureManifest<FederatedItemMarketSummaryWorld> = {
  id: "federated-item-market-summary",
  uri: "tests/features/federated-item-market-summary.feature",
  createWorld: () => ({}),
  steps,
};

function runtime(listedIds: readonly number[]): CentralMarketGraphTestRuntime {
  return createCentralMarketGraphTestRuntime({
    observedAt,
    marketSummaries: listedIds.map(marketSummary),
  });
}

async function executeMarketSummaryQuery(world: FederatedItemMarketSummaryWorld): Promise<void> {
  assert.ok(world.runtime);
  assert.ok(world.requestedIds);
  const response = await world.runtime.fetch(
    new Request("https://central-market.internal/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `
          query FederatedItemMarketSummaries($ids: [ID!]!) {
            items(ids: $ids, locale: EN) {
              id
              locale
              marketSummary(region: EU) {
                region
                observedAt
                isListed
                basePrice
                currentStock
                totalTrades
              }
            }
          }
        `,
        variables: { ids: world.requestedIds.map(String) },
      }),
    }),
  );
  assert.equal(response.status, 200);
  world.response = await response.json();
}

function itemIds(first: number, count: number): readonly number[] {
  return Array.from({ length: count }, (_unused, index) => first + index);
}

function marketSummary(itemId: number): MarketSummary {
  return {
    itemId,
    basePrice: itemId * 1_000,
    currentStock: itemId - 30_000,
    totalTrades: itemId * 10,
  };
}

function listedSummary(itemId: number) {
  const summary = marketSummary(itemId);
  return {
    region: "EU",
    observedAt,
    isListed: true,
    basePrice: summary.basePrice,
    currentStock: summary.currentStock,
    totalTrades: summary.totalTrades,
  };
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function responseItems(
  world: FederatedItemMarketSummaryWorld,
): readonly Readonly<Record<string, unknown>>[] {
  const response = requiredRecord(world.response);
  const data = requiredRecord(response.data);
  assert.ok(Array.isArray(data.items));
  return data.items.map(requiredRecord);
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function requiredRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError("Expected a GraphQL response object");
  return value;
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const field = value[key];
  if (typeof field !== "string") throw new TypeError(`Expected GraphQL field ${key} to be a string`);
  return field;
}
