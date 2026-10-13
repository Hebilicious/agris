import { buildSubgraphSchema, printSubgraphSchema } from "@apollo/subgraph";
import { positiveItemId } from "@agris/pearl-abyss/item-id";
import { PEARL_ABYSS_ITEM_LOCALE_DESCRIPTIONS } from "@agris/pearl-abyss/locales";
import { PEARL_ABYSS_REGION_DESCRIPTIONS } from "@agris/pearl-abyss/regions";
import { MarketSummaryBudgetExceededError, PearlAbyssUpstreamError } from "@agris/pearl-abyss/server";
import SchemaBuilder, { initContextCache } from "@pothos/core";
import DataloaderPlugin from "@pothos/plugin-dataloader";
import DirectivePlugin from "@pothos/plugin-directives";
import FederationPlugin from "@pothos/plugin-federation";
import { GraphQLError, parse } from "graphql";
import { createYoga, maskError as maskWithYoga } from "graphql-yoga";

import {
  requestScopedMarketReader,
  type HotMarketItem,
  type ItemLocale,
  type MarketCatalogItem,
  type MarketCategory,
  type MarketListing,
  type MarketOrder,
  type MarketPricePoint,
  type MarketReader,
  type MarketRegion,
  type MarketRegistration,
  type MarketSale,
  type MarketSummary,
} from "./market-reader.js";
import { dateTime, dateTimeFromEpochSeconds, enhancementLevel, safeInteger } from "./market-semantics.js";

export * from "./market-reader.js";
export * from "./market-semantics.js";

// The catalog subgraph defines `Query` and `ItemLocale` too. Composition keeps one description for each, so both
// subgraphs give the same text; `schema:check` fails when the two differ.
const QUERY_DESCRIPTION = "Read-only queries over the Central Market and the item catalog.";
const ITEM_LOCALE_DESCRIPTION = "A language for item names. Prices and counts are the same in every language.";

export interface MarketClock {
  nowIso(): string;
}

export interface MarketSubgraphInput {
  readonly reader: MarketReader;
  readonly clock: MarketClock;
}

export interface MarketSubgraphRuntime {
  readonly schema: ReturnType<typeof createMarketSchema>;
  readonly sdl: string;
  readonly fetch: (request: Request, input?: MarketSubgraphInput) => Promise<Response>;
}

interface MarketServerContext {
  readonly reader: MarketReader;
  readonly clock: MarketClock;
}

interface MarketGraphContext extends MarketServerContext {
  readonly observations: Map<string, MarketObservation>;
}

interface MarketView {
  readonly region: MarketRegion;
  readonly locale: ItemLocale;
  readonly observation: MarketObservation;
}

interface SummaryWithListing extends MarketSummary {
  readonly isListed: boolean;
}

interface MarketItemView {
  readonly itemId: number;
  readonly region: MarketRegion;
  readonly locale: ItemLocale;
  readonly category: MarketCategory | null;
  readonly prefetchedListings: readonly MarketListing[] | null;
  /** The summary fields; `Market.items` reads them from Pearl Abyss only when a query selects one. */
  readonly summary: () => Promise<SummaryWithListing>;
}

interface MarketItemSummaryView extends MarketSummary {
  readonly region: MarketRegion;
  readonly observedAt: string;
  readonly isListed: boolean;
}

interface HotMarketItemView extends HotMarketItem {
  readonly region: MarketRegion;
  readonly locale: ItemLocale;
}

interface MarketRegistrationView extends MarketRegistration {
  readonly locale: ItemLocale;
}

interface ItemReference {
  readonly id: string;
  readonly locale: ItemLocale;
}

interface ItemMarketSummaryKey {
  readonly itemId: number;
  readonly locale: ItemLocale;
}

interface SchemaTypes {
  Context: MarketGraphContext;
  DefaultFieldNullability: false;
  Scalars: {
    SafeInteger: { Input: number; Output: number };
    DateTime: { Input: string; Output: string };
  };
}

export function createMarketSubgraph(input?: MarketSubgraphInput): MarketSubgraphRuntime {
  const schema = createMarketSchema();
  const yoga = createYoga<MarketServerContext, MarketGraphContext>({
    schema,
    context: ({ reader, clock }) => ({
      ...initContextCache(),
      reader: requestScopedMarketReader(readErrorsAsQueryErrors(reader)),
      clock,
      observations: new Map(),
    }),
    graphqlEndpoint: "/graphql",
    graphiql: false,
    landingPage: false,
    logging: false,
    maskedErrors: { maskError: maskMarketError },
  });
  return {
    schema,
    sdl: printSubgraphSchema(schema),
    fetch: (request, executionInput = input) => {
      if (executionInput === undefined) throw new TypeError("Market reader and clock are required for execution");
      return Promise.resolve(yoga.fetch(request, { reader: executionInput.reader, clock: executionInput.clock }));
    },
  };
}

/**
 * The codes a market error reaches a caller with, each from `marketError`. Every other error is masked to
 * `INTERNAL_SERVER_ERROR`, so no internal text, such as how a Pearl Abyss answer failed to decode, leaves the subgraph.
 *
 * - `BAD_USER_INPUT`: the query is wrong; the message says what to change.
 * - `QUERY_BUDGET_EXCEEDED`: the query asks for more than the deployment's budget allows; ask for less in one query.
 * - `UPSTREAM_UNAVAILABLE`: Pearl Abyss could not be reached, did not answer in time, or sent an unreadable answer.
 */
type MarketErrorCode = "BAD_USER_INPUT" | "QUERY_BUDGET_EXCEEDED" | "UPSTREAM_UNAVAILABLE";

const INTERNAL_ERROR_MESSAGE = "The market subgraph could not answer this field.";

/**
 * The errors `marketError` made. The mask recognizes them by identity rather than by class, because graphql-js can
 * wrap an error in a `GraphQLError` from another copy of graphql than the one this module imports.
 */
const MARKET_ERRORS = new WeakSet<Error>();

/**
 * The reader, with each way a Pearl Abyss read can fail reported as a `MarketErrorCode` with a fixed message.
 * A read the invocation budget refused is `QUERY_BUDGET_EXCEEDED`: the query asks for more Pearl Abyss requests than
 * the deployment's subrequest limit allows, which the caller fixes by asking less. Any other failed read is
 * `UPSTREAM_UNAVAILABLE`, without the reason, which is about Pearl Abyss's internals.
 */
function readErrorsAsQueryErrors(reader: MarketReader): MarketReader {
  const guard = <Value>(read: () => Promise<Value>): Promise<Value> =>
    read().catch((error: unknown) => {
      throw readErrorAsQueryError(error);
    });
  return {
    readSummaries: (input) => guard(() => reader.readSummaries(input)),
    readListings: (input) => guard(() => reader.readListings(input)),
    readOrderBook: (input) => guard(() => reader.readOrderBook(input)),
    readPriceHistory: (input) => guard(() => reader.readPriceHistory(input)),
    readCatalog: (input) => guard(() => reader.readCatalog(input)),
    readHotItems: (input) => guard(() => reader.readHotItems(input)),
    readRegistrations: (input) => guard(() => reader.readRegistrations(input)),
  };
}

function readErrorAsQueryError(error: unknown): unknown {
  if (!(error instanceof PearlAbyssUpstreamError)) return error;
  switch (error.code) {
    case "upstream/budget-exceeded":
      return marketError(
        "The query needs more Pearl Abyss requests than this deployment's subrequest limit allows. Ask for fewer " +
          "markets, items or categories in one query.",
        "QUERY_BUDGET_EXCEEDED",
      );
    case "upstream/invalid-response":
    case "upstream/rate-limited":
    case "upstream/timeout":
    case "upstream/unavailable":
      return marketError("The Central Market could not be read.", "UPSTREAM_UNAVAILABLE");
  }
}

/** An error a caller may read: its message is written for them, and its code says what to do. */
function marketError(message: string, code: MarketErrorCode): GraphQLError {
  const error = new GraphQLError(message, { extensions: { code } });
  MARKET_ERRORS.add(error);
  return error;
}

/** A client argument the market cannot use, as a `BAD_USER_INPUT` error that says what is wrong with it. */
function clientInput<Value>(parse: () => Value): Value {
  try {
    return parse();
  } catch (error: unknown) {
    if (error instanceof TypeError || error instanceof RangeError) throw marketError(error.message, "BAD_USER_INPUT");
    throw error;
  }
}

/**
 * The market subgraph's error mask. An error from `marketError` passes, wherever graphql-js wrapped it. Everything
 * else goes through Yoga's own mask, which passes the errors graphql-js raises about the request itself (they describe
 * only the public schema) and replaces any other with `INTERNAL_SERVER_ERROR` and one fixed message, keeping its
 * location and path. It never adds the original error, whatever `NODE_ENV` says.
 */
function maskMarketError(error: unknown): Error {
  if (wrapsMarketError(error)) return error;
  return maskWithYoga(error, INTERNAL_ERROR_MESSAGE, false);
}

function wrapsMarketError(error: unknown): error is Error {
  let current: unknown = error;
  while (current instanceof Error) {
    if (MARKET_ERRORS.has(current)) return true;
    current = "originalError" in current ? current.originalError : undefined;
  }
  return false;
}

export function subgraphSchemaFromSdl(sdl: string) {
  return buildSubgraphSchema({ typeDefs: parse(sdl) });
}

function createMarketSchema() {
  const builder = new SchemaBuilder<SchemaTypes>({
    defaultFieldNullability: false,
    plugins: [DataloaderPlugin, DirectivePlugin, FederationPlugin],
  });

  const MarketRegionRef = builder.enumType("MarketRegion", {
    description: "A Central Market region. Each region has its own prices, stock and orders.",
    values: PEARL_ABYSS_REGION_DESCRIPTIONS,
  });
  const ItemLocaleRef = builder.enumType("ItemLocale", {
    description: ITEM_LOCALE_DESCRIPTION,
    values: PEARL_ABYSS_ITEM_LOCALE_DESCRIPTIONS,
  });
  const PriceDirectionRef = builder.enumType("PriceDirection", {
    description: "Which way a hot item's price is moving.",
    values: {
      UP: { description: "The price is rising." },
      DOWN: { description: "The price is falling." },
      UNKNOWN: { description: "The direction is not known." },
    },
  });
  const SafeIntegerRef = builder.scalarType("SafeInteger", {
    description:
      "A whole number from 0 to 9007199254740991 (2^53 - 1), sent as a JSON number. Used for silver amounts and " +
      "counts too large for Int.",
    serialize: safeInteger,
    parseValue: safeInteger,
  });
  const DateTimeRef = builder.scalarType("DateTime", {
    description: "A time in UTC, in RFC 3339 format, such as 2026-08-23T00:00:00.000Z.",
    serialize: dateTime,
    parseValue: dateTime,
  });
  const MarketCategoryInputRef = builder.inputType("MarketCategoryInput", {
    description: "A Central Market category, by its numeric codes.",
    fields: (field) => ({
      main: field.int({ required: true, description: "The main category code, such as 1, 5 or 10." }),
      sub: field.int({
        required: false,
        description: "The subcategory code within `main`. Omit it for every subcategory of `main`.",
      }),
    }),
  });

  const MarketItemSummaryRef = builder.objectRef<MarketItemSummaryView>("MarketItemSummary").implement({
    description: "An item's headline market numbers in one region.",
    fields: (field) => ({
      region: field.expose("region", { type: MarketRegionRef, description: "The region these numbers are for." }),
      observedAt: field.expose("observedAt", {
        type: DateTimeRef,
        description: "When these numbers were read from the market, in UTC.",
      }),
      isListed: field.exposeBoolean("isListed", {
        description:
          "Whether the market has data for the item. False both for an item that is not listed and for an unknown ID.",
      }),
      basePrice: field.expose("basePrice", {
        type: SafeIntegerRef,
        nullable: true,
        description: "The item's base price, in silver. Null when `isListed` is false.",
      }),
      currentStock: field.expose("currentStock", {
        type: SafeIntegerRef,
        nullable: true,
        description: "How many units are for sale now. Null when `isListed` is false.",
      }),
      totalTrades: field.expose("totalTrades", {
        type: SafeIntegerRef,
        nullable: true,
        description: "How many units have been traded in total. Null when `isListed` is false.",
      }),
    }),
  });

  // The catalog subgraph owns `Item`, `Item.id` and `Item.locale`, and documents them; this subgraph adds a field.
  const ItemRef = builder.externalRef("Item", builder.selection<ItemReference>("id locale"), (reference) => reference);
  ItemRef.implement({
    fields: (field) => ({
      id: field.exposeID("id"),
      locale: field.expose("locale", { type: ItemLocaleRef }),
      marketSummary: field.loadable({
        type: MarketItemSummaryRef,
        nullable: true,
        description: "The item's market numbers in one region. Null when they could not be read; the error says why.",
        byPath: true,
        args: {
          region: field.arg({ type: MarketRegionRef, required: true, description: "The region." }),
        },
        loaderOptions: {
          cacheKeyFn: (key: ItemMarketSummaryKey) => `${key.locale}:${key.itemId}`,
        },
        load: (keys, context, arguments_) => loadItemMarketSummaries(keys, arguments_.region, context),
        resolve: (item) => ({ itemId: clientInput(() => positiveItemId(item.id)), locale: item.locale }),
      }),
    }),
  });

  const MarketCategoryRef = builder.objectRef<MarketCategory>("MarketCategory").implement({
    description: "The Central Market category an item is listed under, by its numeric codes.",
    fields: (field) => ({
      main: field.exposeInt("main", { description: "The main category code." }),
      sub: field.exposeInt("sub", { nullable: true, description: "The subcategory code. Null when not known." }),
    }),
  });

  const MarketSaleRef = builder.objectRef<MarketSale>("MarketSale").implement({
    description: "The most recent sale in a listing row.",
    fields: (field) => ({
      price: field.expose("price", { type: SafeIntegerRef, description: "The sale price, in silver." }),
      timestamp: field.expose("timestamp", {
        type: SafeIntegerRef,
        description: "When it sold, in Unix seconds.",
      }),
      occurredAt: field.field({
        type: DateTimeRef,
        nullable: true,
        description: "When it sold, in UTC. Null when `timestamp` is 0.",
        resolve: (sale) => dateTimeFromEpochSeconds(sale.timestamp),
      }),
    }),
  });

  const MarketListingRef = builder.objectRef<MarketListing>("MarketListing").implement({
    description: "One row of an item's listings, covering a range of enhancement levels.",
    fields: (field) => ({
      minimumEnhancementLevel: field.exposeInt("minimumEnhancementLevel", {
        description: "The lowest enhancement level this row covers, from 0 to 20.",
      }),
      maximumEnhancementLevel: field.exposeInt("maximumEnhancementLevel", {
        description: "The highest enhancement level this row covers, from 0 to 20.",
      }),
      basePrice: field.expose("basePrice", { type: SafeIntegerRef, description: "The base price, in silver." }),
      currentStock: field.expose("currentStock", {
        type: SafeIntegerRef,
        description: "How many units in this range are for sale now.",
      }),
      totalTrades: field.expose("totalTrades", {
        type: SafeIntegerRef,
        description: "How many units in this range have been traded in total.",
      }),
      minimumPrice: field.expose("minimumPrice", {
        type: SafeIntegerRef,
        description: "The lowest price the market allows for this range, in silver.",
      }),
      maximumPrice: field.expose("maximumPrice", {
        type: SafeIntegerRef,
        description: "The highest price the market allows for this range, in silver.",
      }),
      lastSale: field.expose("lastSale", {
        type: MarketSaleRef,
        nullable: true,
        description: "The most recent sale in this range. Null when no sale is recorded.",
      }),
    }),
  });

  const MarketOrderRef = builder.objectRef<MarketOrder>("MarketOrder").implement({
    description: "One price level of an item's order book.",
    fields: (field) => ({
      price: field.expose("price", { type: SafeIntegerRef, description: "The price level, in silver." }),
      sellOrders: field.expose("sellOrders", {
        type: SafeIntegerRef,
        description: "How many units are offered for sale at this price.",
      }),
      buyOrders: field.expose("buyOrders", {
        type: SafeIntegerRef,
        description: "How many units buyers have ordered at this price.",
      }),
    }),
  });

  const MarketPricePointRef = builder.objectRef<MarketPricePoint>("MarketPricePoint").implement({
    description: "One price in an item's price history. The market gives no dates, only the order of the prices.",
    fields: (field) => ({
      offsetFromLatest: field.exposeInt("offsetFromLatest", {
        description: "How many prices before the newest this one is: 0 is the newest, 89 the oldest.",
      }),
      price: field.expose("price", { type: SafeIntegerRef, description: "The price, in silver." }),
    }),
  });

  const MarketItemRef = builder.objectRef<MarketItemView>("MarketItem").implement({
    description: "One item on one region's market.",
    fields: (field) => ({
      item: field.field({
        type: ItemRef,
        description: "The item, named in the market's language.",
        resolve: (item) => ({ id: String(item.itemId), locale: item.locale }),
      }),
      isListed: field.boolean({
        description:
          "Whether the market has data for the item. False both for an item that is not listed and for an unknown ID.",
        resolve: async (item) => (await item.summary()).isListed,
      }),
      category: field.expose("category", {
        type: MarketCategoryRef,
        nullable: true,
        description: "The category the item is listed under. Null except for items from `Market.catalog`.",
      }),
      basePrice: field.field({
        type: SafeIntegerRef,
        nullable: true,
        description: "The item's base price, in silver. Null when `isListed` is false.",
        resolve: async (item) => (await item.summary()).basePrice,
      }),
      currentStock: field.field({
        type: SafeIntegerRef,
        nullable: true,
        description: "How many units are for sale now. Null when `isListed` is false.",
        resolve: async (item) => (await item.summary()).currentStock,
      }),
      totalTrades: field.field({
        type: SafeIntegerRef,
        nullable: true,
        description: "How many units have been traded in total. Null when `isListed` is false.",
        resolve: async (item) => (await item.summary()).totalTrades,
      }),
      listings: field.field({
        type: [MarketListingRef],
        nullable: true,
        description:
          "The item's listings, one row per range of enhancement levels. Null when they could not be read; the error " +
          "says why.",
        resolve: (item, _arguments, context) =>
          item.prefetchedListings ??
          context.reader.readListings({ region: item.region, locale: item.locale, itemId: item.itemId }),
      }),
      orderBook: field.field({
        type: [MarketOrderRef],
        nullable: true,
        description:
          "The buy and sell orders at one enhancement level, one entry per price. Null when they could not be read; " +
          "the error says why.",
        args: {
          enhancementLevel: field.arg.int({
            required: true,
            defaultValue: 0,
            description: "The enhancement level to read, from 0 to 20; 0 is unenhanced.",
          }),
        },
        resolve: (item, arguments_, context) =>
          context.reader.readOrderBook({
            region: item.region,
            locale: item.locale,
            itemId: item.itemId,
            enhancementLevel: clientInput(() => enhancementLevel(arguments_.enhancementLevel ?? 0)),
          }),
      }),
      priceHistory: field.field({
        type: [MarketPricePointRef],
        nullable: true,
        description:
          "The item's last 90 prices at one enhancement level, in silver, oldest first. Null when they could not be " +
          "read; the error says why.",
        args: {
          enhancementLevel: field.arg.int({
            required: true,
            defaultValue: 0,
            description: "The enhancement level to read, from 0 to 20; 0 is unenhanced.",
          }),
        },
        resolve: (item, arguments_, context) =>
          context.reader.readPriceHistory({
            region: item.region,
            locale: item.locale,
            itemId: item.itemId,
            enhancementLevel: clientInput(() => enhancementLevel(arguments_.enhancementLevel ?? 0)),
          }),
      }),
    }),
  });

  const HotMarketItemRef = builder.objectRef<HotMarketItemView>("HotMarketItem").implement({
    description: "An item on a region's hot list, with its price change.",
    fields: (field) => ({
      marketItem: field.field({
        type: MarketItemRef,
        description: "The item's market data.",
        resolve: (hotItem) =>
          marketItemView(hotItem.summary, hotItem.region, hotItem.locale, true, null, hotItem.listings),
      }),
      direction: field.expose("direction", { type: PriceDirectionRef, description: "Which way the price is moving." }),
      amount: field.expose("amount", {
        type: SafeIntegerRef,
        description: "How much the price changed, in silver.",
      }),
    }),
  });

  const MarketRegistrationRef = builder.objectRef<MarketRegistrationView>("MarketRegistration").implement({
    description: "An item waiting in a region's registration queue to be listed.",
    fields: (field) => ({
      item: field.field({
        type: ItemRef,
        description: "The item, named in the market's language.",
        resolve: (registration) => ({ id: String(registration.itemId), locale: registration.locale }),
      }),
      enhancementLevel: field.exposeInt("enhancementLevel", {
        description: "The enhancement level being registered, from 0 to 20.",
      }),
      price: field.expose("price", { type: SafeIntegerRef, description: "The registered price, in silver." }),
      timestamp: field.expose("timestamp", {
        type: SafeIntegerRef,
        description: "The queue entry's time, in Unix seconds.",
      }),
      registeredAt: field.field({
        type: DateTimeRef,
        description: "The queue entry's time, in UTC.",
        resolve: (registration) => {
          const registeredAt = dateTimeFromEpochSeconds(registration.timestamp);
          if (registeredAt === null) throw new TypeError("Registration timestamp must be positive");
          return registeredAt;
        },
      }),
    }),
  });

  const MarketRef = builder.objectRef<MarketView>("Market").implement({
    description: "One region's Central Market, with item names in one language.",
    fields: (field) => ({
      region: field.expose("region", { type: MarketRegionRef, description: "The market's region." }),
      locale: field.expose("locale", { type: ItemLocaleRef, description: "The language of item names." }),
      observedAt: field.field({
        type: DateTimeRef,
        description: "When this market's data was read, in UTC, which tells you how old the answer is.",
        resolve: (market) => market.observation.value(),
      }),
      items: field.field({
        type: [MarketItemRef],
        nullable: true,
        description:
          "The given items, in the order given, duplicates included. Null when they could not be read; the error says " +
          "why.",
        args: {
          ids: field.arg.idList({ required: true, description: "Item IDs: positive whole numbers, as strings." }),
        },
        resolve: (market, arguments_, context) => {
          const itemIds = clientInput(() => arguments_.ids.map(positiveItemId));
          // Captured here, before any read these items lead to, since a listing-only query reads no summary.
          market.observation.capture();
          // One batched summary read serves every item, and only once a summary field asks for it: a query that
          // selects listings alone starts its listing reads at once and spends no upstream request on summaries.
          let summariesById: Promise<ReadonlyMap<number, MarketSummary>> | undefined;
          const readSummaries = () =>
            (summariesById ??= market.observation
              .beforeRead(() => context.reader.readSummaries({ region: market.region, locale: market.locale, itemIds }))
              .then((summaries) => new Map(summaries.map((summary) => [summary.itemId, summary]))));
          return itemIds.map((itemId) => ({
            itemId,
            region: market.region,
            locale: market.locale,
            category: null,
            prefetchedListings: null,
            summary: async () => {
              const summary = (await readSummaries()).get(itemId);
              return summary === undefined
                ? { ...unlistedSummary(itemId), isListed: false }
                : { ...summary, isListed: true };
            },
          }));
        },
      }),
      catalog: field.field({
        type: [MarketItemRef],
        nullable: true,
        description:
          "Every item listed in a category, ordered by item ID. Null when it could not be read; the error says why.",
        args: {
          category: field.arg({
            type: MarketCategoryInputRef,
            required: false,
            description: "The category to list. Omit it for every category.",
          }),
        },
        resolve: async (market, arguments_, context) => {
          const category: MarketCategory | null = arguments_.category
            ? { main: arguments_.category.main, sub: arguments_.category.sub ?? null }
            : null;
          const items = await market.observation.beforeRead(() =>
            context.reader.readCatalog({ region: market.region, locale: market.locale, category }),
          );
          return items.map((item) => catalogItemView(item, market.region, market.locale));
        },
      }),
      hotItems: field.field({
        type: [HotMarketItemRef],
        nullable: true,
        description: "The region's hot items. Null when they could not be read; the error says why.",
        resolve: async (market, _arguments, context) => {
          const hotItems = await market.observation.beforeRead(() =>
            context.reader.readHotItems({ region: market.region, locale: market.locale }),
          );
          return hotItems.map((hotItem) => ({ ...hotItem, region: market.region, locale: market.locale }));
        },
      }),
      registrations: field.field({
        type: [MarketRegistrationRef],
        nullable: true,
        description:
          "The items waiting in the region's registration queue to be listed. Null when it could not be read; the " +
          "error says why.",
        resolve: async (market, _arguments, context) => {
          const registrations = await market.observation.beforeRead(() =>
            context.reader.readRegistrations({ region: market.region, locale: market.locale }),
          );
          return registrations.map((registration) => ({ ...registration, locale: market.locale }));
        },
      }),
    }),
  });

  builder.queryType({
    description: QUERY_DESCRIPTION,
    fields: (field) => ({
      market: field.field({
        type: MarketRef,
        description: "One region's Central Market.",
        args: {
          region: field.arg({ type: MarketRegionRef, required: true, description: "The region." }),
          locale: field.arg({
            type: ItemLocaleRef,
            required: true,
            defaultValue: "EN",
            description: "The language for item names.",
          }),
        },
        resolve: (_root, arguments_, context) => ({
          region: arguments_.region,
          locale: arguments_.locale ?? "EN",
          observation: observationFor(context, arguments_.region, arguments_.locale ?? "EN"),
        }),
      }),
    }),
  });

  return builder.toSubGraphSchema({ linkUrl: "https://specs.apollo.dev/federation/v2.6" });
}

function observationFor(context: MarketGraphContext, region: MarketRegion, locale: ItemLocale): MarketObservation {
  const key = `${region}:${locale}`;
  const existing = context.observations.get(key);
  if (existing !== undefined) return existing;
  const observation = new MarketObservation(context.clock);
  context.observations.set(key, observation);
  return observation;
}

const MARKET_SUMMARY_BATCH_LIMIT = 100;

async function loadItemMarketSummaries(
  keys: readonly ItemMarketSummaryKey[],
  region: MarketRegion,
  context: MarketGraphContext,
): Promise<readonly MarketItemSummaryView[]> {
  const locales = new Set(keys.map((key) => key.locale));
  if (locales.size !== 1) throw new TypeError("One Item market-summary batch must use exactly one locale");
  const locale = keys[0]?.locale;
  if (locale === undefined) throw new TypeError("Item market-summary batch must not be empty");

  const itemIds = [...new Set(keys.map((key) => key.itemId))];
  if (itemIds.length > MARKET_SUMMARY_BATCH_LIMIT) {
    throw marketError(
      `Market summary batch exceeds the ${MARKET_SUMMARY_BATCH_LIMIT}-Item limit`,
      "QUERY_BUDGET_EXCEEDED",
    );
  }

  const observation = observationFor(context, region, locale);
  let summaries: readonly MarketSummary[];
  try {
    summaries = await observation.beforeRead(() => context.reader.readSummaries({ region, locale, itemIds }));
  } catch (error: unknown) {
    if (error instanceof MarketSummaryBudgetExceededError) {
      throw marketError(
        `Market summary operation exceeds this deployment's limit of ${error.limit} distinct batches`,
        "QUERY_BUDGET_EXCEEDED",
      );
    }
    throw error;
  }
  const observedAt = await observation.value();
  const summariesById = new Map(summaries.map((summary) => [summary.itemId, summary]));
  return keys.map((key) => {
    const summary = summariesById.get(key.itemId);
    return marketItemSummaryView(summary ?? unlistedSummary(key.itemId), region, observedAt, summary !== undefined);
  });
}

class MarketObservation {
  private state: { readonly status: "uncaptured" } | { readonly status: "captured"; readonly value: string } = {
    status: "uncaptured",
  };

  public constructor(private readonly clock: MarketClock) {}

  public beforeRead<Value>(read: () => Promise<Value>): Promise<Value> {
    this.capture();
    return read();
  }

  public async value(): Promise<string> {
    await Promise.resolve();
    this.capture();
    if (this.state.status === "uncaptured") throw new TypeError("Market observation was not captured");
    return this.state.value;
  }

  public capture(): void {
    if (this.state.status === "captured") return;
    this.state = { status: "captured", value: dateTime(this.clock.nowIso()) };
  }
}

function marketItemView(
  summary: MarketSummary,
  region: MarketRegion,
  locale: ItemLocale,
  isListed: boolean,
  category: MarketCategory | null,
  prefetchedListings: readonly MarketListing[] | null,
): MarketItemView {
  const listed: SummaryWithListing = { ...summary, isListed };
  return {
    itemId: summary.itemId,
    region,
    locale,
    category,
    prefetchedListings,
    summary: () => Promise.resolve(listed),
  };
}

function marketItemSummaryView(
  summary: MarketSummary,
  region: MarketRegion,
  observedAt: string,
  isListed: boolean,
): MarketItemSummaryView {
  return { ...summary, region, observedAt, isListed };
}

function catalogItemView(item: MarketCatalogItem, region: MarketRegion, locale: ItemLocale): MarketItemView {
  return marketItemView(item, region, locale, true, item.category, null);
}

function unlistedSummary(itemId: number): MarketSummary {
  return { itemId, basePrice: null, currentStock: null, totalTrades: null };
}
