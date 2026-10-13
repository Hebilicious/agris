import type { PearlAbyssItemLocale } from "@agris/pearl-abyss/locales";
import { PEARL_ABYSS_REGIONS, type PearlAbyssRegion } from "@agris/pearl-abyss/regions";

export const MARKET_REGIONS = PEARL_ABYSS_REGIONS.map((region) => region.code);

export type MarketRegion = PearlAbyssRegion;
export type ItemLocale = PearlAbyssItemLocale;
export type PriceDirection = "UP" | "DOWN" | "UNKNOWN";

export interface MarketCategory {
  readonly main: number;
  readonly sub: number | null;
}

export interface MarketSummary {
  readonly itemId: number;
  readonly basePrice: number | null;
  readonly currentStock: number | null;
  readonly totalTrades: number | null;
}

export interface MarketSale {
  readonly price: number;
  readonly timestamp: number;
}

export interface MarketListing {
  readonly minimumEnhancementLevel: number;
  readonly maximumEnhancementLevel: number;
  readonly basePrice: number;
  readonly currentStock: number;
  readonly totalTrades: number;
  readonly minimumPrice: number;
  readonly maximumPrice: number;
  readonly lastSale: MarketSale | null;
}

export interface MarketOrder {
  readonly price: number;
  readonly sellOrders: number;
  readonly buyOrders: number;
}

export interface MarketPricePoint {
  readonly offsetFromLatest: number;
  readonly price: number;
}

export interface MarketCatalogItem extends MarketSummary {
  readonly category: MarketCategory;
}

export interface HotMarketItem {
  readonly summary: MarketSummary;
  readonly listings: readonly MarketListing[];
  readonly direction: PriceDirection;
  readonly amount: number;
}

export interface MarketRegistration {
  readonly itemId: number;
  readonly enhancementLevel: number;
  readonly price: number;
  readonly timestamp: number;
}

export interface MarketReadContext {
  readonly region: MarketRegion;
  readonly locale: ItemLocale;
}

export interface MarketSummariesRead extends MarketReadContext {
  readonly itemIds: readonly number[];
}

export interface MarketItemRead extends MarketReadContext {
  readonly itemId: number;
}

export interface MarketEnhancedItemRead extends MarketItemRead {
  readonly enhancementLevel: number;
}

export interface MarketCatalogRead extends MarketReadContext {
  /** One main category, or one subcategory of it when `sub` is set. */
  readonly category: MarketCategory;
}

export interface MarketReader {
  readSummaries(input: MarketSummariesRead): Promise<readonly MarketSummary[]>;
  readListings(input: MarketItemRead): Promise<readonly MarketListing[]>;
  readOrderBook(input: MarketEnhancedItemRead): Promise<readonly MarketOrder[]>;
  readPriceHistory(input: MarketEnhancedItemRead): Promise<readonly MarketPricePoint[]>;
  readCatalog(input: MarketCatalogRead): Promise<readonly MarketCatalogItem[]>;
  readHotItems(input: MarketReadContext): Promise<readonly HotMarketItem[]>;
  readRegistrations(input: MarketReadContext): Promise<readonly MarketRegistration[]>;
}

/** The most distinct items one summary read may ask for, whichever field asks: `Market.items` or `Item.marketSummary`. */
export const MARKET_SUMMARY_BATCH_LIMIT = 100;

/** A summary read asked for more than `MARKET_SUMMARY_BATCH_LIMIT` distinct items; nothing was read. */
export class MarketSummaryBatchLimitError extends Error {
  public constructor(public readonly limit: number) {
    super(`Market summary batch exceeds the ${limit}-Item limit`);
    this.name = "MarketSummaryBatchLimitError";
  }
}

/**
 * One reader per GraphQL execution: matching reads share one upstream read, and a summary read over
 * `MARKET_SUMMARY_BATCH_LIMIT` distinct items is refused before it reaches `reader`.
 */
export function requestScopedMarketReader(reader: MarketReader): MarketReader {
  const summaryReads = new Map<string, Promise<readonly MarketSummary[]>>();
  const listingReads = new Map<string, Promise<readonly MarketListing[]>>();
  const orderBookReads = new Map<string, Promise<readonly MarketOrder[]>>();
  const priceHistoryReads = new Map<string, Promise<readonly MarketPricePoint[]>>();
  const catalogReads = new Map<string, Promise<readonly MarketCatalogItem[]>>();
  const hotItemReads = new Map<string, Promise<readonly HotMarketItem[]>>();
  const registrationReads = new Map<string, Promise<readonly MarketRegistration[]>>();
  return {
    readSummaries: (input) => {
      const itemIds = [...new Set(input.itemIds)].sort((left, right) => left - right);
      if (itemIds.length > MARKET_SUMMARY_BATCH_LIMIT) {
        return Promise.reject(new MarketSummaryBatchLimitError(MARKET_SUMMARY_BATCH_LIMIT));
      }
      return memoized(summaryReads, key(input, `summaries:${itemIds.join(",")}`), () =>
        reader.readSummaries({ ...input, itemIds }),
      );
    },
    readListings: (input) =>
      memoized(listingReads, key(input, `listings:${input.itemId}`), () => reader.readListings(input)),
    readOrderBook: (input) =>
      memoized(orderBookReads, key(input, `order-book:${input.itemId}:${input.enhancementLevel}`), () =>
        reader.readOrderBook(input),
      ),
    readPriceHistory: (input) =>
      memoized(priceHistoryReads, key(input, `price-history:${input.itemId}:${input.enhancementLevel}`), () =>
        reader.readPriceHistory(input),
      ),
    readCatalog: (input) =>
      memoized(catalogReads, key(input, `catalog:${input.category.main}:${input.category.sub ?? "all"}`), () =>
        reader.readCatalog(input),
      ),
    readHotItems: (input) => memoized(hotItemReads, key(input, "hot-items"), () => reader.readHotItems(input)),
    readRegistrations: (input) =>
      memoized(registrationReads, key(input, "registrations"), () => reader.readRegistrations(input)),
  };
}

function key(input: MarketReadContext, operation: string): string {
  return `${input.region}:${input.locale}:${operation}`;
}

function memoized<Value>(
  reads: Map<string, Promise<Value>>,
  cacheKey: string,
  start: () => Promise<Value>,
): Promise<Value> {
  const existing = reads.get(cacheKey);
  if (existing !== undefined) return existing;
  const pending = start();
  reads.set(cacheKey, pending);
  return pending;
}
