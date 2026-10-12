import assert from "node:assert/strict";

import {
  createMarketSubgraph,
  type HotMarketItem,
  type MarketCatalogItem,
  type MarketListing,
  type MarketOrder,
  type MarketPricePoint,
  type MarketReader,
  type MarketRegistration,
  type MarketSummary,
} from "../../packages/market-subgraph/src/index.ts";
import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";

interface SelectionAwareMarketWorld {
  reader?: RecordingMarketReader;
  response?: unknown;
  events?: string[];
}

const steps: readonly StepDefinition<SelectionAwareMarketWorld>[] = [
  step("market summaries exist for items 10006 and 10007", noStepArguments, (world) => {
    world.events = [];
    world.reader = new RecordingMarketReader(
      [
        { itemId: 10_006, basePrice: 377_000, currentStock: 0, totalTrades: 114_184 },
        { itemId: 10_007, basePrice: 76_500, currentStock: 44, totalTrades: 514_774 },
      ],
      world.events,
    );
  }),
  step("a caller requests summary IDs 10007, 99999, 10006, and 10007", noStepArguments, async (world) => {
    assert.ok(world.reader);
    assert.ok(world.events);
    const runtime = createMarketSubgraph({
      reader: world.reader,
      clock: {
        nowIso: () => {
          world.events?.push("clock");
          return "2026-08-23T12:34:56.000Z";
        },
      },
    });
    const response = await runtime.fetch(
      graphRequest(`
        query OrderedSummaries {
          market(region: NA) {
            observedAt
            items(ids: ["10007", "99999", "10006", "10007"]) {
              item { id locale }
              isListed
              basePrice
              currentStock
              totalTrades
            }
          }
        }
      `),
    );
    assert.equal(response.status, 200);
    world.response = await response.json();
  }),
  step("the market items remain in caller order with 99999 marked unlisted", noStepArguments, (world) => {
    assert.deepEqual(world.response, {
      data: {
        market: {
          observedAt: "2026-08-23T12:34:56.000Z",
          items: [
            marketItem("10007", true, 76_500, 44, 514_774),
            marketItem("99999", false, null, null, null),
            marketItem("10006", true, 377_000, 0, 114_184),
            marketItem("10007", true, 76_500, 44, 514_774),
          ],
        },
      },
    });
  }),
  step("the reader receives one distinct summary batch for 10006, 10007, and 99999", noStepArguments, (world) => {
    assert.deepEqual(world.reader?.summaryBatches, [[10_006, 10_007, 99_999]]);
  }),
  step("an omitted detail field causes no detail read", noStepArguments, (world) => {
    assert.deepEqual(world.reader?.listingReads, []);
    assert.deepEqual(world.reader?.orderBookReads, []);
    assert.deepEqual(world.reader?.priceHistoryReads, []);
    assert.equal(world.reader?.catalogReads, 0);
    assert.equal(world.reader?.hotItemReads, 0);
    assert.equal(world.reader?.registrationReads, 0);
  }),
  step("observedAt is captured immediately before that summary read", noStepArguments, (world) => {
    assert.deepEqual(world.events, ["clock", "summaries"]);
  }),
];

export const selectionAwareMarketFeature: ExecutableFeatureManifest<SelectionAwareMarketWorld> = {
  id: "selection-aware-market",
  uri: "tests/features/selection-aware-market.feature",
  createWorld: () => ({}),
  steps,
};

class RecordingMarketReader implements MarketReader {
  public readonly summaryBatches: number[][] = [];
  public readonly listingReads: number[] = [];
  public readonly orderBookReads: [number, number][] = [];
  public readonly priceHistoryReads: [number, number][] = [];
  public catalogReads = 0;
  public hotItemReads = 0;
  public registrationReads = 0;

  public constructor(
    private readonly summaries: readonly MarketSummary[],
    private readonly events: string[],
    private readonly failListings = false,
  ) {}

  public readSummaries(input: { readonly itemIds: readonly number[] }): Promise<readonly MarketSummary[]> {
    this.events.push("summaries");
    this.summaryBatches.push([...input.itemIds]);
    return Promise.resolve(this.summaries.filter((summary) => input.itemIds.includes(summary.itemId)));
  }

  public readListings(input: { readonly itemId: number }): Promise<readonly MarketListing[]> {
    this.listingReads.push(input.itemId);
    return this.failListings ? Promise.reject(new Error("listing upstream failed")) : Promise.resolve([listing]);
  }

  public readOrderBook(input: {
    readonly itemId: number;
    readonly enhancementLevel: number;
  }): Promise<readonly MarketOrder[]> {
    this.orderBookReads.push([input.itemId, input.enhancementLevel]);
    return Promise.resolve([{ price: 370_000, sellOrders: 3, buyOrders: 4 }]);
  }

  public readPriceHistory(input: {
    readonly itemId: number;
    readonly enhancementLevel: number;
  }): Promise<readonly MarketPricePoint[]> {
    this.priceHistoryReads.push([input.itemId, input.enhancementLevel]);
    return Promise.resolve([{ offsetFromLatest: 0, price: 371_000 }]);
  }

  public readCatalog(): Promise<readonly MarketCatalogItem[]> {
    this.catalogReads += 1;
    return Promise.resolve([{ ...listedSummary, category: { main: 1, sub: 2 } }]);
  }

  public readHotItems(): Promise<readonly HotMarketItem[]> {
    this.hotItemReads += 1;
    return Promise.resolve([{ summary: listedSummary, listings: [listing], direction: "UP", amount: 10_000 }]);
  }

  public readRegistrations(): Promise<readonly MarketRegistration[]> {
    this.registrationReads += 1;
    return Promise.resolve([{ itemId: 10_006, enhancementLevel: 20, price: 370_000, timestamp: 1_777_780_800 }]);
  }
}

const listedSummary: MarketSummary = {
  itemId: 10_006,
  basePrice: 377_000,
  currentStock: 0,
  totalTrades: 114_184,
};

const listing: MarketListing = {
  minimumEnhancementLevel: 0,
  maximumEnhancementLevel: 20,
  basePrice: 377_000,
  currentStock: 0,
  totalTrades: 114_184,
  minimumPrice: 350_000,
  maximumPrice: 400_000,
  lastSale: { price: 375_000, timestamp: 1_777_780_800 },
};

function graphRequest(query: string): Request {
  return new Request("https://market-subgraph.internal/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
}

function marketItem(
  id: string,
  isListed: boolean,
  basePrice: number | null,
  currentStock: number | null,
  totalTrades: number | null,
) {
  return {
    item: { id, locale: "EN" },
    isListed,
    basePrice,
    currentStock,
    totalTrades,
  };
}
