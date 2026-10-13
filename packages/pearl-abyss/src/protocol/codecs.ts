import { decodePearlAbyssHuffman } from "./huffman.js";
import {
  pearlAbyssProtocolFailure,
  pearlAbyssProtocolSuccess,
  type PearlAbyssCapabilityResponse,
  type PearlAbyssCatalogItem,
  type PearlAbyssHotItem,
  type PearlAbyssListing,
  type PearlAbyssMarketOrder,
  type PearlAbyssPricePoint,
  type PearlAbyssProtocolResult,
  type PearlAbyssRegistration,
  type PearlAbyssRequest,
  type PearlAbyssSummary,
} from "./models.js";

export function decodePearlAbyssResponseBody(
  request: PearlAbyssRequest,
  bytes: Uint8Array,
): PearlAbyssProtocolResult<string> {
  if (request.compression === "json") return decodeJsonEnvelope(bytes);
  const possibleJson = decodeAscii(bytes);
  if (possibleJson.ok && possibleJson.value.trimStart().startsWith("{")) return decodeJsonEnvelope(bytes);
  return decodePearlAbyssHuffman(bytes);
}

export function decodePearlAbyssPayload(
  request: PearlAbyssRequest,
  payload: string,
): PearlAbyssProtocolResult<PearlAbyssCapabilityResponse> {
  if (payload === "0" && request.capability !== "price-history") {
    return pearlAbyssProtocolSuccess({ capability: request.capability, rows: [] });
  }
  switch (request.capability) {
    case "summaries":
      return decodeSummaries(request, payload);
    case "listings":
      return decodeListings(request, payload);
    case "catalog":
      return decodeCatalog(request, payload);
    case "order-book":
      return decodeOrderBook(payload);
    case "price-history":
      return decodePriceHistory(payload);
    case "hot-items":
      return decodeHotItems(payload);
    case "registrations":
      return decodeRegistrations(payload);
  }
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function decodeJsonEnvelope(
  bytes: Uint8Array,
): PearlAbyssProtocolResult<string> {
  const text = decodeAscii(bytes);
  if (!text.ok) return text;
  let value: unknown;
  try {
    value = JSON.parse(text.value);
  } catch {
    return invalidResponse("Pearl Abyss JSON is malformed");
  }
  if (!record(value) || !exactKeys(value, ["resultCode", "resultMsg"])) {
    return invalidResponse("Pearl Abyss JSON envelope has an unknown shape");
  }
  if (value.resultCode !== 0 || typeof value.resultMsg !== "string") {
    return invalidResponse("Pearl Abyss JSON envelope is unsuccessful or malformed");
  }
  return pearlAbyssProtocolSuccess(value.resultMsg);
}

function decodeAscii(bytes: Uint8Array): PearlAbyssProtocolResult<string> {
  let value = "";
  for (const byte of bytes) {
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && (byte < 0x20 || byte > 0x7e)) {
      return invalidResponse("Pearl Abyss response is not ASCII text");
    }
    value += String.fromCharCode(byte);
  }
  return pearlAbyssProtocolSuccess(value);
}

function decodeSummaries(
  request: Extract<PearlAbyssRequest, { readonly capability: "summaries" }>,
  payload: string,
): PearlAbyssProtocolResult<PearlAbyssCapabilityResponse> {
  const rows = positionalRows(payload, 4);
  if (!rows.ok) return rows;
  const requested = new Set(request.itemIds);
  const summaries: PearlAbyssSummary[] = [];
  for (const [itemId, currentStock, basePrice, totalTrades] of rows.value) {
    if (itemId === undefined || currentStock === undefined || basePrice === undefined || totalTrades === undefined) {
      return invalidResponse("Pearl Abyss summary row is incomplete");
    }
    if (!positive(itemId) || !requested.has(itemId)) return invalidResponse("Pearl Abyss summary item is unexpected");
    summaries.push({ itemId, currentStock, basePrice, totalTrades });
  }
  return pearlAbyssProtocolSuccess({ capability: "summaries", rows: summaries });
}

function decodeListings(
  request: Extract<PearlAbyssRequest, { readonly capability: "listings" }>,
  payload: string,
): PearlAbyssProtocolResult<PearlAbyssCapabilityResponse> {
  const rows = positionalRows(payload, 10);
  if (!rows.ok) return rows;
  const listings: PearlAbyssListing[] = [];
  for (const row of rows.value) {
    const [
      itemId,
      minimumEnhancementLevel,
      maximumEnhancementLevel,
      basePrice,
      currentStock,
      totalTrades,
      minimumPrice,
      maximumPrice,
      lastSalePrice,
      lastSaleTimestamp,
    ] = row;
    if (
      itemId === undefined ||
      minimumEnhancementLevel === undefined ||
      maximumEnhancementLevel === undefined ||
      basePrice === undefined ||
      currentStock === undefined ||
      totalTrades === undefined ||
      minimumPrice === undefined ||
      maximumPrice === undefined ||
      lastSalePrice === undefined ||
      lastSaleTimestamp === undefined
    ) {
      return invalidResponse("Pearl Abyss listing row is incomplete");
    }
    if (
      itemId !== request.itemId ||
      !enhancement(minimumEnhancementLevel) ||
      !enhancement(maximumEnhancementLevel) ||
      minimumEnhancementLevel > maximumEnhancementLevel
    ) {
      return invalidResponse("Pearl Abyss listing identity or enhancement range is invalid");
    }
    listings.push({
      itemId,
      minimumEnhancementLevel,
      maximumEnhancementLevel,
      basePrice,
      currentStock,
      totalTrades,
      minimumPrice,
      maximumPrice,
      lastSalePrice,
      lastSaleTimestamp,
    });
  }
  return pearlAbyssProtocolSuccess({ capability: "listings", rows: listings });
}

function decodeCatalog(
  request: Extract<PearlAbyssRequest, { readonly capability: "catalog" }>,
  payload: string,
): PearlAbyssProtocolResult<PearlAbyssCapabilityResponse> {
  const rows = positionalRows(payload, 4);
  if (!rows.ok) return rows;
  const catalog: PearlAbyssCatalogItem[] = [];
  for (const [itemId, currentStock, totalTrades, basePrice] of rows.value) {
    if (itemId === undefined || currentStock === undefined || totalTrades === undefined || basePrice === undefined) {
      return invalidResponse("Pearl Abyss catalog row is incomplete");
    }
    if (!positive(itemId)) return invalidResponse("Pearl Abyss catalog item ID is invalid");
    catalog.push({
      itemId,
      currentStock,
      totalTrades,
      basePrice,
      mainCategory: request.mainCategory,
      subCategory: request.subCategory,
    });
  }
  return pearlAbyssProtocolSuccess({ capability: "catalog", rows: catalog });
}

function decodeOrderBook(payload: string): PearlAbyssProtocolResult<PearlAbyssCapabilityResponse> {
  const rows = positionalRows(payload, 3);
  if (!rows.ok) return rows;
  const orders: PearlAbyssMarketOrder[] = [];
  for (const [price, sellOrders, buyOrders] of rows.value) {
    if (price === undefined || sellOrders === undefined || buyOrders === undefined) {
      return invalidResponse("Pearl Abyss order row is incomplete");
    }
    orders.push({ price, sellOrders, buyOrders });
  }
  return pearlAbyssProtocolSuccess({ capability: "order-book", rows: orders });
}

function decodePriceHistory(payload: string): PearlAbyssProtocolResult<PearlAbyssCapabilityResponse> {
  if (payload.length === 0 || payload.includes("|")) return invalidResponse("Pearl Abyss history shape is invalid");
  const prices = numericFields(payload.split("-"));
  if (!prices.ok) return prices;
  if (prices.value.length !== 90) return invalidResponse("Pearl Abyss history must contain exactly 90 prices");
  const history: PearlAbyssPricePoint[] = prices.value.map((price, index) => ({
    offsetFromLatest: prices.value.length - index - 1,
    price,
  }));
  return pearlAbyssProtocolSuccess({ capability: "price-history", rows: history });
}

function decodeHotItems(payload: string): PearlAbyssProtocolResult<PearlAbyssCapabilityResponse> {
  const rows = positionalRows(payload, 12);
  if (!rows.ok) return rows;
  const hotItems: PearlAbyssHotItem[] = [];
  for (const row of rows.value) {
    const [
      itemId,
      minimumEnhancementLevel,
      maximumEnhancementLevel,
      basePrice,
      currentStock,
      totalTrades,
      priceChangeDirectionCode,
      priceChangeAmount,
      minimumPrice,
      maximumPrice,
      lastSalePrice,
      lastSaleTimestamp,
    ] = row;
    if (
      itemId === undefined ||
      minimumEnhancementLevel === undefined ||
      maximumEnhancementLevel === undefined ||
      basePrice === undefined ||
      currentStock === undefined ||
      totalTrades === undefined ||
      priceChangeDirectionCode === undefined ||
      priceChangeAmount === undefined ||
      minimumPrice === undefined ||
      maximumPrice === undefined ||
      lastSalePrice === undefined ||
      lastSaleTimestamp === undefined
    ) {
      return invalidResponse("Pearl Abyss hot-item row is incomplete");
    }
    if (
      !positive(itemId) ||
      !enhancement(minimumEnhancementLevel) ||
      !enhancement(maximumEnhancementLevel) ||
      minimumEnhancementLevel > maximumEnhancementLevel
    ) {
      return invalidResponse("Pearl Abyss hot-item identity or enhancement range is invalid");
    }
    hotItems.push({
      itemId,
      minimumEnhancementLevel,
      maximumEnhancementLevel,
      basePrice,
      currentStock,
      totalTrades,
      priceChangeDirectionCode,
      priceChangeAmount,
      minimumPrice,
      maximumPrice,
      lastSalePrice,
      lastSaleTimestamp,
    });
  }
  return pearlAbyssProtocolSuccess({ capability: "hot-items", rows: hotItems });
}

function decodeRegistrations(payload: string): PearlAbyssProtocolResult<PearlAbyssCapabilityResponse> {
  const rows = positionalRows(payload, 4);
  if (!rows.ok) return rows;
  const registrations: PearlAbyssRegistration[] = [];
  for (const [itemId, enhancementLevel, price, registeredTimestamp] of rows.value) {
    if (
      itemId === undefined ||
      enhancementLevel === undefined ||
      price === undefined ||
      registeredTimestamp === undefined
    ) {
      return invalidResponse("Pearl Abyss registration row is incomplete");
    }
    if (!positive(itemId) || !enhancement(enhancementLevel)) {
      return invalidResponse("Pearl Abyss registration identity or enhancement level is invalid");
    }
    registrations.push({ itemId, enhancementLevel, price, registeredTimestamp });
  }
  return pearlAbyssProtocolSuccess({ capability: "registrations", rows: registrations });
}

function positionalRows(
  payload: string,
  expectedFields: number,
): PearlAbyssProtocolResult<readonly (readonly number[])[]> {
  const segments = payload.split("|");
  if (segments.at(-1) === "") segments.pop();
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    return invalidResponse("Pearl Abyss positional rows are empty");
  }
  const rows: number[][] = [];
  for (const segment of segments) {
    const fields = segment.split("-");
    if (fields.length !== expectedFields) return invalidResponse("Pearl Abyss positional row has an unknown shape");
    const values = numericFields(fields);
    if (!values.ok) return values;
    rows.push(values.value);
  }
  return pearlAbyssProtocolSuccess(rows);
}

function numericFields(fields: readonly string[]): PearlAbyssProtocolResult<number[]> {
  const values: number[] = [];
  for (const field of fields) {
    if (!/^\d+$/.test(field)) return invalidResponse("Pearl Abyss positional field is not an unsigned integer");
    const value = Number(field);
    if (!Number.isSafeInteger(value) || value < 0) {
      return invalidResponse("Pearl Abyss positional field is outside the safe-integer range");
    }
    values.push(value);
  }
  return pearlAbyssProtocolSuccess(values);
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function record(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function enhancement(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 20;
}

function invalidResponse(message: string): PearlAbyssProtocolResult<never> {
  return pearlAbyssProtocolFailure("upstream/invalid-response", message);
}
