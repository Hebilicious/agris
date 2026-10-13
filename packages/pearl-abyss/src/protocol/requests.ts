import {
  pearlAbyssProtocolFailure,
  pearlAbyssProtocolSuccess,
  type PearlAbyssProtocolResult,
  type PearlAbyssRequest,
  type PearlAbyssRequestInput,
} from "./models.js";
import { PEARL_ABYSS_REGION_HOSTS } from "./regions.js";

type RequestTransportField = "region" | "locale" | "method" | "url" | "headers";
type PearlAbyssRequestContract = PearlAbyssRequest extends infer Request
  ? Request extends PearlAbyssRequest
    ? Omit<Request, RequestTransportField>
    : never
  : never;

const COMMON_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "BlackDesert",
} as const;

export function buildPearlAbyssRequest(input: PearlAbyssRequestInput): PearlAbyssProtocolResult<PearlAbyssRequest> {
  const request = requestContract(input);
  if (!request.ok) return request;
  const host = PEARL_ABYSS_REGION_HOSTS[input.region];
  return pearlAbyssProtocolSuccess({
    ...request.value,
    region: input.region,
    locale: input.locale,
    method: "POST",
    url: `https://${host}/TradeMarket/${request.value.endpoint}`,
    headers: COMMON_HEADERS,
  });
}

function requestContract(input: PearlAbyssRequestInput): PearlAbyssProtocolResult<PearlAbyssRequestContract> {
  switch (input.capability) {
    case "summaries": {
      if (input.itemIds.length === 0 || input.itemIds.some((itemId) => !positiveSafeInteger(itemId))) {
        return invalidInput("Summary item IDs must be positive safe integers");
      }
      return pearlAbyssProtocolSuccess({
        capability: input.capability,
        itemIds: [...input.itemIds],
        endpoint: "GetWorldMarketSearchList",
        compression: "json",
        body: JSON.stringify({ keyType: 0, searchResult: input.itemIds.join(",") }),
      });
    }
    case "listings": {
      if (!positiveSafeInteger(input.itemId)) return invalidInput("Listing item ID must be a positive safe integer");
      return pearlAbyssProtocolSuccess({
        capability: input.capability,
        itemId: input.itemId,
        endpoint: "GetWorldMarketSubList",
        compression: "json",
        body: JSON.stringify({ keyType: 0, mainKey: input.itemId }),
      });
    }
    case "catalog": {
      if (!positiveSafeInteger(input.mainCategory) || !nonNegativeSafeInteger(input.subCategory)) {
        return invalidInput("Market categories must be safe non-negative integers with a positive main category");
      }
      return pearlAbyssProtocolSuccess({
        capability: input.capability,
        mainCategory: input.mainCategory,
        subCategory: input.subCategory,
        endpoint: "GetWorldMarketList",
        compression: "huffman",
        body: JSON.stringify({ keyType: 0, mainCategory: input.mainCategory, subCategory: input.subCategory }),
      });
    }
    case "order-book": {
      if (!positiveSafeInteger(input.itemId) || !enhancementLevel(input.enhancementLevel)) {
        return invalidInput("Order-book item and enhancement level must be valid");
      }
      return pearlAbyssProtocolSuccess({
        capability: input.capability,
        itemId: input.itemId,
        enhancementLevel: input.enhancementLevel,
        endpoint: "GetBiddingInfoList",
        compression: "huffman",
        body: JSON.stringify({ keyType: 0, mainKey: input.itemId, subKey: input.enhancementLevel }),
      });
    }
    case "price-history": {
      if (!positiveSafeInteger(input.itemId) || !enhancementLevel(input.enhancementLevel)) {
        return invalidInput("Price-history item and enhancement level must be valid");
      }
      return pearlAbyssProtocolSuccess({
        capability: input.capability,
        itemId: input.itemId,
        enhancementLevel: input.enhancementLevel,
        endpoint: "GetMarketPriceInfo",
        compression: "json",
        body: JSON.stringify({ keyType: 0, mainKey: input.itemId, subKey: input.enhancementLevel }),
      });
    }
    case "hot-items":
      return pearlAbyssProtocolSuccess({
        capability: input.capability,
        endpoint: "GetWorldMarketHotList",
        compression: "huffman",
        body: JSON.stringify({ keyType: 0 }),
      });
    case "registrations":
      return pearlAbyssProtocolSuccess({
        capability: input.capability,
        endpoint: "GetWorldMarketWaitList",
        compression: "json",
        body: JSON.stringify({ keyType: 0 }),
      });
  }
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function enhancementLevel(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 20;
}

function invalidInput(message: string): PearlAbyssProtocolResult<never> {
  return pearlAbyssProtocolFailure("input/invalid", message);
}
