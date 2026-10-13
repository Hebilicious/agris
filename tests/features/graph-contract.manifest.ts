import assert from "node:assert/strict";

import {
  createCentralMarketGraphTestRuntime,
  type CentralMarketGraphTestRuntime,
} from "../../packages/core/src/testing.ts";
import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";

interface CentralMarketGraphContractWorld {
  runtime?: CentralMarketGraphTestRuntime;
  response?: unknown;
  itemId?: number;
}

const steps: readonly StepDefinition<CentralMarketGraphContractWorld>[] = [
  step("the EU market reports item 44195 with base price 21400000000", noStepArguments, (world) => {
    world.itemId = 44_195;
    world.runtime = createCentralMarketGraphTestRuntime({
      observedAt: "2026-08-23T00:00:00.000Z",
      marketSummaries: [
        {
          itemId: 44_195,
          basePrice: 21_400_000_000,
          currentStock: 256,
          totalTrades: 5_750_000_000,
        },
      ],
    });
  }),
  step("the EU market reports unknown catalog item 999999999 with base price 21400000000", noStepArguments, (world) => {
    world.itemId = 999_999_999;
    world.runtime = createCentralMarketGraphTestRuntime({
      observedAt: "2026-08-23T00:00:00.000Z",
      marketSummaries: [
        {
          itemId: 999_999_999,
          basePrice: 21_400_000_000,
          currentStock: 256,
          totalTrades: 5_750_000_000,
        },
      ],
    });
  }),
  step(
    "an authorized caller queries that market item through the private Agris Proxy",
    noStepArguments,
    async (world) => {
      assert.ok(world.runtime);
      const response = await world.runtime.fetch(
        new Request("https://central-market.internal/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `
            query MarketSummary($region: MarketRegion!, $locale: ItemLocale!, $ids: [ID!]!) {
              market(region: $region, locale: $locale) {
                items(ids: $ids) {
                  item {
                    id
                    locale
                    name
                    grade
                  }
                  basePrice
                  currentStock
                  totalTrades
                }
              }
            }
          `,
            variables: { region: "EU", locale: "EN", ids: [String(world.itemId)] },
          }),
        }),
      );
      assert.equal(response.status, 200);
      world.response = await response.json();
    },
  ),
  step(
    "the graph returns the market price and catalog-owned item metadata in one nested result",
    noStepArguments,
    (world) => {
      assert.deepEqual(world.response, {
        data: {
          market: {
            items: [
              {
                item: { id: "44195", locale: "EN", name: "Memory Fragment", grade: 0 },
                basePrice: 21_400_000_000,
                currentStock: 256,
                totalTrades: 5_750_000_000,
              },
            ],
          },
        },
      });
    },
  ),
  step(
    "the graph requests one Pearl Abyss summary batch and one catalog subgraph request",
    noStepArguments,
    (world) => {
      assert.deepEqual(world.runtime?.observedWork(), {
        marketSummaryBatches: [[world.itemId]],
        catalogSubgraphRequests: 1,
      });
    },
  ),
  step("the graph returns market facts with nullable missing catalog metadata", noStepArguments, (world) => {
    assert.deepEqual(world.response, {
      data: {
        market: {
          items: [
            {
              item: { id: "999999999", locale: "EN", name: null, grade: null },
              basePrice: 21_400_000_000,
              currentStock: 256,
              totalTrades: 5_750_000_000,
            },
          ],
        },
      },
    });
  }),
];

export const centralMarketGraphContractFeature: ExecutableFeatureManifest<CentralMarketGraphContractWorld> = {
  id: "central-market-graph",
  uri: "tests/features/graph-contract.feature",
  createWorld: () => ({}),
  steps,
};
