export type PearlAbyssCapability =
  | "summaries"
  | "listings"
  | "catalog"
  | "order-book"
  | "price-history"
  | "hot-items"
  | "registrations";

export type PearlAbyssCompression = "json" | "huffman";

import type { PearlAbyssRegion } from "./region-descriptor.js";
import type { PearlAbyssItemLocale } from "./locale-descriptor.js";

export { PEARL_ABYSS_REGIONS, type PearlAbyssRegion, type PearlAbyssRegionSlug } from "./region-descriptor.js";
export type { PearlAbyssItemLocale } from "./locale-descriptor.js";

interface PearlAbyssRequestContext {
  readonly region: PearlAbyssRegion;
  readonly locale: PearlAbyssItemLocale;
}

export interface PearlAbyssSummariesRequestInput extends PearlAbyssRequestContext {
  readonly capability: "summaries";
  readonly itemIds: readonly number[];
}

export interface PearlAbyssListingsRequestInput extends PearlAbyssRequestContext {
  readonly capability: "listings";
  readonly itemId: number;
}

export interface PearlAbyssCatalogRequestInput extends PearlAbyssRequestContext {
  readonly capability: "catalog";
  readonly mainCategory: number;
  readonly subCategory: number;
}

export interface PearlAbyssOrderBookRequestInput extends PearlAbyssRequestContext {
  readonly capability: "order-book";
  readonly itemId: number;
  readonly enhancementLevel: number;
}

export interface PearlAbyssPriceHistoryRequestInput extends PearlAbyssRequestContext {
  readonly capability: "price-history";
  readonly itemId: number;
  readonly enhancementLevel: number;
}

export interface PearlAbyssHotItemsRequestInput extends PearlAbyssRequestContext {
  readonly capability: "hot-items";
}

export interface PearlAbyssRegistrationsRequestInput extends PearlAbyssRequestContext {
  readonly capability: "registrations";
}

export type PearlAbyssRequestInput =
  | PearlAbyssSummariesRequestInput
  | PearlAbyssListingsRequestInput
  | PearlAbyssCatalogRequestInput
  | PearlAbyssOrderBookRequestInput
  | PearlAbyssPriceHistoryRequestInput
  | PearlAbyssHotItemsRequestInput
  | PearlAbyssRegistrationsRequestInput;

interface PearlAbyssRequestBase {
  readonly capability: PearlAbyssCapability;
  readonly region: PearlAbyssRegion;
  readonly locale: PearlAbyssItemLocale;
  readonly endpoint: string;
  readonly compression: PearlAbyssCompression;
  readonly method: "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface PearlAbyssSummariesRequest extends PearlAbyssRequestBase {
  readonly capability: "summaries";
  readonly itemIds: readonly number[];
}

export interface PearlAbyssListingsRequest extends PearlAbyssRequestBase {
  readonly capability: "listings";
  readonly itemId: number;
}

export interface PearlAbyssCatalogRequest extends PearlAbyssRequestBase {
  readonly capability: "catalog";
  readonly mainCategory: number;
  readonly subCategory: number;
}

export interface PearlAbyssOrderBookRequest extends PearlAbyssRequestBase {
  readonly capability: "order-book";
  readonly itemId: number;
  readonly enhancementLevel: number;
}

export interface PearlAbyssPriceHistoryRequest extends PearlAbyssRequestBase {
  readonly capability: "price-history";
  readonly itemId: number;
  readonly enhancementLevel: number;
}

export interface PearlAbyssHotItemsRequest extends PearlAbyssRequestBase {
  readonly capability: "hot-items";
}

export interface PearlAbyssRegistrationsRequest extends PearlAbyssRequestBase {
  readonly capability: "registrations";
}

export type PearlAbyssRequest =
  | PearlAbyssSummariesRequest
  | PearlAbyssListingsRequest
  | PearlAbyssCatalogRequest
  | PearlAbyssOrderBookRequest
  | PearlAbyssPriceHistoryRequest
  | PearlAbyssHotItemsRequest
  | PearlAbyssRegistrationsRequest;

export interface PearlAbyssSummary {
  readonly itemId: number;
  readonly currentStock: number;
  readonly basePrice: number;
  readonly totalTrades: number;
}

export interface PearlAbyssListing {
  readonly itemId: number;
  readonly minimumEnhancementLevel: number;
  readonly maximumEnhancementLevel: number;
  readonly basePrice: number;
  readonly currentStock: number;
  readonly totalTrades: number;
  readonly minimumPrice: number;
  readonly maximumPrice: number;
  readonly lastSalePrice: number;
  readonly lastSaleTimestamp: number;
}

export interface PearlAbyssCatalogItem {
  readonly itemId: number;
  readonly currentStock: number;
  readonly totalTrades: number;
  readonly basePrice: number;
  readonly mainCategory: number;
  readonly subCategory: number;
}

export interface PearlAbyssMarketOrder {
  readonly price: number;
  readonly sellOrders: number;
  readonly buyOrders: number;
}

export interface PearlAbyssPricePoint {
  readonly offsetFromLatest: number;
  readonly price: number;
}

export interface PearlAbyssHotItem {
  readonly itemId: number;
  readonly minimumEnhancementLevel: number;
  readonly maximumEnhancementLevel: number;
  readonly basePrice: number;
  readonly currentStock: number;
  readonly totalTrades: number;
  readonly priceChangeDirectionCode: number;
  readonly priceChangeAmount: number;
  readonly minimumPrice: number;
  readonly maximumPrice: number;
  readonly lastSalePrice: number;
  readonly lastSaleTimestamp: number;
}

export interface PearlAbyssRegistration {
  readonly itemId: number;
  readonly enhancementLevel: number;
  readonly price: number;
  readonly registeredTimestamp: number;
}

export type PearlAbyssCapabilityResponse =
  | { readonly capability: "summaries"; readonly rows: readonly PearlAbyssSummary[] }
  | { readonly capability: "listings"; readonly rows: readonly PearlAbyssListing[] }
  | { readonly capability: "catalog"; readonly rows: readonly PearlAbyssCatalogItem[] }
  | { readonly capability: "order-book"; readonly rows: readonly PearlAbyssMarketOrder[] }
  | { readonly capability: "price-history"; readonly rows: readonly PearlAbyssPricePoint[] }
  | { readonly capability: "hot-items"; readonly rows: readonly PearlAbyssHotItem[] }
  | { readonly capability: "registrations"; readonly rows: readonly PearlAbyssRegistration[] };

export interface PearlAbyssProtocolError {
  readonly code: "input/invalid" | "upstream/invalid-response";
  readonly message: string;
}

export type PearlAbyssProtocolResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: PearlAbyssProtocolError };

export function pearlAbyssProtocolSuccess<const Value>(value: Value): PearlAbyssProtocolResult<Value> {
  return { ok: true, value };
}

export function pearlAbyssProtocolFailure(
  code: PearlAbyssProtocolError["code"],
  message: string,
): PearlAbyssProtocolResult<never> {
  return { ok: false, error: { code, message } };
}
