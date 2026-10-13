import assert from "node:assert/strict";

import {
  buildPearlAbyssRequest,
  decodePearlAbyssPayload,
  decodePearlAbyssResponseBody,
  type PearlAbyssCapability,
  type PearlAbyssCapabilityResponse,
  type PearlAbyssProtocolResult,
  type PearlAbyssRequestInput,
} from "../../packages/pearl-abyss/src/server/index.ts";
import {
  observedBiddingInfoCompressedBase64,
  pearlAbyssProtocolFixtures,
} from "./fixtures/pearl-abyss/protocol-fixtures.ts";
import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";

interface PearlAbyssCapabilitiesWorld {
  decoded?: ReadonlyMap<PearlAbyssCapability, PearlAbyssCapabilityResponse>;
  observedOrderBook?: PearlAbyssCapabilityResponse;
  invalidResults?: readonly PearlAbyssProtocolResult<unknown>[];
}

const requestInputs = [
  { capability: "summaries", region: "NA", locale: "EN", itemIds: [10_007, 10_006] },
  { capability: "listings", region: "NA", locale: "EN", itemId: 44_195 },
  { capability: "catalog", region: "NA", locale: "EN", mainCategory: 1, subCategory: 1 },
  { capability: "order-book", region: "NA", locale: "EN", itemId: 10_006, enhancementLevel: 0 },
  { capability: "price-history", region: "NA", locale: "EN", itemId: 10_007, enhancementLevel: 0 },
  { capability: "hot-items", region: "NA", locale: "EN" },
  { capability: "registrations", region: "NA", locale: "EN" },
] as const satisfies readonly PearlAbyssRequestInput[];

const steps: readonly StepDefinition<PearlAbyssCapabilitiesWorld>[] = [
  step("retained decoded payloads for all seven Pearl Abyss capabilities", noStepArguments, (world) => {
    const requests = new Map(requestInputs.map((input) => [input.capability, required(buildPearlAbyssRequest(input))]));
    const payloads = {
      summaries: pearlAbyssProtocolFixtures.summaries.payload,
      listings: pearlAbyssProtocolFixtures.listings.payload,
      catalog: pearlAbyssProtocolFixtures.catalog.payload,
      "order-book": pearlAbyssProtocolFixtures.orderBook.payload,
      "price-history": pearlAbyssProtocolFixtures.priceHistory.payload,
      "hot-items": pearlAbyssProtocolFixtures.hotItems.payload,
      registrations: pearlAbyssProtocolFixtures.registrations.payload,
    } satisfies Readonly<Record<PearlAbyssCapability, string>>;
    Reflect.set(world, "requests", requests);
    world.decoded = new Map(
      [...requests].map(([capability, request]) => [
        capability,
        required(decodePearlAbyssPayload(request, payloads[capability])),
      ]),
    );
  }),
  step("the retained payloads are decoded through their capability requests", noStepArguments, () => undefined),
  step("summary item 10007 has stock 44, base price 76500, and 514774 trades", noStepArguments, (world) => {
    const response = responseFor(world, "summaries");
    assert.equal(response.capability, "summaries");
    if (response.capability !== "summaries") return;
    assert.deepEqual(response.rows[0], { itemId: 10_007, currentStock: 44, basePrice: 76_500, totalTrades: 514_774 });
  }),
  step(
    "listing item 44195 has enhancement range 0 to 0, base price 1680000, stock 43483, 708081197 trades, price bounds 75000 to 5000000, and last sale 1670000 at 1787364852",
    noStepArguments,
    (world) => {
      const response = responseFor(world, "listings");
      assert.equal(response.capability, "listings");
      if (response.capability !== "listings") return;
      assert.deepEqual(response.rows[0], {
        itemId: 44_195,
        minimumEnhancementLevel: 0,
        maximumEnhancementLevel: 0,
        basePrice: 1_680_000,
        currentStock: 43_483,
        totalTrades: 708_081_197,
        minimumPrice: 75_000,
        maximumPrice: 5_000_000,
        lastSalePrice: 1_670_000,
        lastSaleTimestamp: 1_787_364_852,
      });
    },
  ),
  step("catalog item 10003 has stock 1, 60715 trades, base price 72000, and category 1-1", noStepArguments, (world) => {
    const response = responseFor(world, "catalog");
    assert.equal(response.capability, "catalog");
    if (response.capability !== "catalog") return;
    assert.deepEqual(response.rows[0], {
      itemId: 10_003,
      currentStock: 1,
      totalTrades: 60_715,
      basePrice: 72_000,
      mainCategory: 1,
      subCategory: 1,
    });
  }),
  step("the first order has price 74500, 0 sell orders, and 9 buy orders", noStepArguments, (world) => {
    const response = responseFor(world, "order-book");
    assert.equal(response.capability, "order-book");
    if (response.capability !== "order-book") return;
    assert.deepEqual(response.rows[0], { price: 74_500, sellOrders: 0, buyOrders: 9 });
  }),
  step(
    "the 90-point history starts 89 offsets from latest at 219302 and ends at offset 0 at 76326",
    noStepArguments,
    (world) => {
      const response = responseFor(world, "price-history");
      assert.equal(response.capability, "price-history");
      if (response.capability !== "price-history") return;
      assert.equal(response.rows.length, 90);
      assert.deepEqual(response.rows[0], { offsetFromLatest: 89, price: 219_302 });
      assert.deepEqual(response.rows.at(-1), { offsetFromLatest: 0, price: 76_326 });
    },
  ),
  step(
    "hot item 784 has enhancement range 0 to 0, base price 166000, stock 0, 31223 trades, direction code 2, change 30000, price bounds 2670 to 190000, and last sale 166000 at 1692679415",
    noStepArguments,
    (world) => {
      const response = responseFor(world, "hot-items");
      assert.equal(response.capability, "hot-items");
      if (response.capability !== "hot-items") return;
      assert.deepEqual(response.rows[0], {
        itemId: 784,
        minimumEnhancementLevel: 0,
        maximumEnhancementLevel: 0,
        basePrice: 166_000,
        currentStock: 0,
        totalTrades: 31_223,
        priceChangeDirectionCode: 2,
        priceChangeAmount: 30_000,
        minimumPrice: 2_670,
        maximumPrice: 190_000,
        lastSalePrice: 166_000,
        lastSaleTimestamp: 1_692_679_415,
      });
    },
  ),
  step(
    "registration item 705517 has enhancement 20, price 45800000000, and timestamp 1693064335",
    noStepArguments,
    (world) => {
      const response = responseFor(world, "registrations");
      assert.equal(response.capability, "registrations");
      if (response.capability !== "registrations") return;
      assert.deepEqual(response.rows[0], {
        itemId: 705_517,
        enhancementLevel: 20,
        price: 45_800_000_000,
        registeredTimestamp: 1_693_064_335,
      });
    },
  ),
  step("the retained first-party compressed bidding response for item 10006", noStepArguments, (world) => {
    const request = required(buildPearlAbyssRequest(requestInputs[3]));
    const bytes = Uint8Array.from(Buffer.from(observedBiddingInfoCompressedBase64, "base64"));
    const payload = required(decodePearlAbyssResponseBody(request, bytes));
    world.observedOrderBook = required(decodePearlAbyssPayload(request, payload));
  }),
  step("the compressed response is decoded through the order-book request", noStepArguments, () => undefined),
  step("its only order has price 371000, 0 sell orders, and 0 buy orders", noStepArguments, (world) => {
    assert.equal(world.observedOrderBook?.capability, "order-book");
    if (world.observedOrderBook?.capability !== "order-book") return;
    assert.deepEqual(world.observedOrderBook.rows, [{ price: 371_000, sellOrders: 0, buyOrders: 0 }]);
  }),
  step("a summary row contains an unrecognized extra position", noStepArguments, (world) => {
    const summaryRequest = required(buildPearlAbyssRequest(requestInputs[0]));
    world.invalidResults = [decodePearlAbyssPayload(summaryRequest, "10007-44-76500-514774-999")];
  }),
  step("a compressed response is truncated", noStepArguments, (world) => {
    const orderRequest = required(buildPearlAbyssRequest(requestInputs[3]));
    const bytes = Uint8Array.from(Buffer.from(observedBiddingInfoCompressedBase64, "base64")).slice(0, 24);
    world.invalidResults = [...(world.invalidResults ?? []), decodePearlAbyssResponseBody(orderRequest, bytes)];
  }),
  step("both Pearl Abyss responses are rejected as invalid upstream data", noStepArguments, (world) => {
    assert.equal(world.invalidResults?.length, 2);
    for (const result of world.invalidResults ?? []) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "upstream/invalid-response");
    }
  }),
];

export const pearlAbyssCapabilitiesFeature: ExecutableFeatureManifest<PearlAbyssCapabilitiesWorld> = {
  id: "pearl-abyss-capabilities",
  uri: "tests/features/pearl-abyss-capabilities.feature",
  createWorld: () => ({}),
  steps,
};

function required<Value>(result: PearlAbyssProtocolResult<Value>): Value {
  if (!result.ok) assert.fail(result.error.message);
  return result.value;
}

function responseFor(
  world: PearlAbyssCapabilitiesWorld,
  capability: PearlAbyssCapability,
): PearlAbyssCapabilityResponse {
  const response = world.decoded?.get(capability);
  assert.ok(response);
  return response;
}
