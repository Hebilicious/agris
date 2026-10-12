import { buildSubgraphSchema, printSubgraphSchema } from "@apollo/subgraph";
import { positiveItemId } from "@agris/pearl-abyss/item-id";
import { PEARL_ABYSS_ITEM_LOCALES } from "@agris/pearl-abyss/locales";
import { MarketSummaryBudgetExceededError } from "@agris/pearl-abyss/server";
import SchemaBuilder, { initContextCache } from "@pothos/core";
import DataloaderPlugin from "@pothos/plugin-dataloader";
import DirectivePlugin from "@pothos/plugin-directives";
import FederationPlugin from "@pothos/plugin-federation";
import { GraphQLError, parse } from "graphql";
import { createYoga } from "graphql-yoga";

import {
  MARKET_REGIONS,
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
      reader: requestScopedMarketReader(reader),
      clock,
      observations: new Map(),
    }),
    graphqlEndpoint: "/graphql",
    graphiql: false,
    landingPage: false,
    logging: false,
    maskedErrors: false,
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

export function subgraphSchemaFromSdl(sdl: string) {
  return buildSubgraphSchema({ typeDefs: parse(sdl) });
}

function createMarketSchema() {
  const builder = new SchemaBuilder<SchemaTypes>({
    defaultFieldNullability: false,
    plugins: [DataloaderPlugin, DirectivePlugin, FederationPlugin],
  });

  const MarketRegionRef = builder.enumType("MarketRegion", { values: MARKET_REGIONS });
  const ItemLocaleRef = builder.enumType("ItemLocale", { values: PEARL_ABYSS_ITEM_LOCALES });
  const PriceDirectionRef = builder.enumType("PriceDirection", {
    values: ["UP", "DOWN", "UNKNOWN"] as const,
  });
  const SafeIntegerRef = builder.scalarType("SafeInteger", {
    description: "A non-negative integer that is safe to represent as a JavaScript number.",
    serialize: safeInteger,
    parseValue: safeInteger,
  });
  const DateTimeRef = builder.scalarType("DateTime", {
    description: "An RFC 3339 UTC timestamp.",
    serialize: dateTime,
    parseValue: dateTime,
  });
  const MarketCategoryInputRef = builder.inputType("MarketCategoryInput", {
    fields: (field) => ({
      main: field.int({ required: true }),
      sub: field.int({ required: false }),
    }),
  });

  const MarketItemSummaryRef = builder.objectRef<MarketItemSummaryView>("MarketItemSummary").implement({
    fields: (field) => ({
      region: field.expose("region", { type: MarketRegionRef }),
      observedAt: field.expose("observedAt", { type: DateTimeRef }),
      isListed: field.exposeBoolean("isListed"),
      basePrice: field.expose("basePrice", { type: SafeIntegerRef, nullable: true }),
      currentStock: field.expose("currentStock", { type: SafeIntegerRef, nullable: true }),
      totalTrades: field.expose("totalTrades", { type: SafeIntegerRef, nullable: true }),
    }),
  });

  const ItemRef = builder.externalRef("Item", builder.selection<ItemReference>("id locale"), (reference) => reference);
  ItemRef.implement({
    fields: (field) => ({
      id: field.exposeID("id"),
      locale: field.expose("locale", { type: ItemLocaleRef }),
      marketSummary: field.loadable({
        type: MarketItemSummaryRef,
        nullable: true,
        byPath: true,
        args: { region: field.arg({ type: MarketRegionRef, required: true }) },
        loaderOptions: {
          cacheKeyFn: (key: ItemMarketSummaryKey) => `${key.locale}:${key.itemId}`,
        },
        load: (keys, context, arguments_) => loadItemMarketSummaries(keys, arguments_.region, context),
        resolve: (item) => ({ itemId: positiveItemId(item.id), locale: item.locale }),
      }),
    }),
  });

  const MarketCategoryRef = builder.objectRef<MarketCategory>("MarketCategory").implement({
    fields: (field) => ({
      main: field.exposeInt("main"),
      sub: field.exposeInt("sub", { nullable: true }),
    }),
  });

  const MarketSaleRef = builder.objectRef<MarketSale>("MarketSale").implement({
    fields: (field) => ({
      price: field.expose("price", { type: SafeIntegerRef }),
      timestamp: field.expose("timestamp", { type: SafeIntegerRef }),
      occurredAt: field.field({
        type: DateTimeRef,
        nullable: true,
        resolve: (sale) => dateTimeFromEpochSeconds(sale.timestamp),
      }),
    }),
  });

  const MarketListingRef = builder.objectRef<MarketListing>("MarketListing").implement({
    fields: (field) => ({
      minimumEnhancementLevel: field.exposeInt("minimumEnhancementLevel"),
      maximumEnhancementLevel: field.exposeInt("maximumEnhancementLevel"),
      basePrice: field.expose("basePrice", { type: SafeIntegerRef }),
      currentStock: field.expose("currentStock", { type: SafeIntegerRef }),
      totalTrades: field.expose("totalTrades", { type: SafeIntegerRef }),
      minimumPrice: field.expose("minimumPrice", { type: SafeIntegerRef }),
      maximumPrice: field.expose("maximumPrice", { type: SafeIntegerRef }),
      lastSale: field.expose("lastSale", { type: MarketSaleRef, nullable: true }),
    }),
  });

  const MarketOrderRef = builder.objectRef<MarketOrder>("MarketOrder").implement({
    fields: (field) => ({
      price: field.expose("price", { type: SafeIntegerRef }),
      sellOrders: field.expose("sellOrders", { type: SafeIntegerRef }),
      buyOrders: field.expose("buyOrders", { type: SafeIntegerRef }),
    }),
  });

  const MarketPricePointRef = builder.objectRef<MarketPricePoint>("MarketPricePoint").implement({
    fields: (field) => ({
      offsetFromLatest: field.exposeInt("offsetFromLatest"),
      price: field.expose("price", { type: SafeIntegerRef }),
    }),
  });

  const MarketItemRef = builder.objectRef<MarketItemView>("MarketItem").implement({
    fields: (field) => ({
      item: field.field({
        type: ItemRef,
        resolve: (item) => ({ id: String(item.itemId), locale: item.locale }),
      }),
      isListed: field.boolean({ resolve: async (item) => (await item.summary()).isListed }),
      category: field.expose("category", { type: MarketCategoryRef, nullable: true }),
      basePrice: field.field({
        type: SafeIntegerRef,
        nullable: true,
        resolve: async (item) => (await item.summary()).basePrice,
      }),
      currentStock: field.field({
        type: SafeIntegerRef,
        nullable: true,
        resolve: async (item) => (await item.summary()).currentStock,
      }),
      totalTrades: field.field({
        type: SafeIntegerRef,
        nullable: true,
        resolve: async (item) => (await item.summary()).totalTrades,
      }),
      listings: field.field({
        type: [MarketListingRef],
        nullable: true,
        resolve: (item, _arguments, context) =>
          item.prefetchedListings ??
          context.reader.readListings({ region: item.region, locale: item.locale, itemId: item.itemId }),
      }),
      orderBook: field.field({
        type: [MarketOrderRef],
        nullable: true,
        args: { enhancementLevel: field.arg.int({ required: true, defaultValue: 0 }) },
        resolve: (item, arguments_, context) =>
          context.reader.readOrderBook({
            region: item.region,
            locale: item.locale,
            itemId: item.itemId,
            enhancementLevel: enhancementLevel(arguments_.enhancementLevel ?? 0),
          }),
      }),
      priceHistory: field.field({
        type: [MarketPricePointRef],
        nullable: true,
        args: { enhancementLevel: field.arg.int({ required: true, defaultValue: 0 }) },
        resolve: (item, arguments_, context) =>
          context.reader.readPriceHistory({
            region: item.region,
            locale: item.locale,
            itemId: item.itemId,
            enhancementLevel: enhancementLevel(arguments_.enhancementLevel ?? 0),
          }),
      }),
    }),
  });

  const HotMarketItemRef = builder.objectRef<HotMarketItemView>("HotMarketItem").implement({
    fields: (field) => ({
      marketItem: field.field({
        type: MarketItemRef,
        resolve: (hotItem) =>
          marketItemView(hotItem.summary, hotItem.region, hotItem.locale, true, null, hotItem.listings),
      }),
      direction: field.expose("direction", { type: PriceDirectionRef }),
      amount: field.expose("amount", { type: SafeIntegerRef }),
    }),
  });

  const MarketRegistrationRef = builder.objectRef<MarketRegistrationView>("MarketRegistration").implement({
    fields: (field) => ({
      item: field.field({
        type: ItemRef,
        resolve: (registration) => ({ id: String(registration.itemId), locale: registration.locale }),
      }),
      enhancementLevel: field.exposeInt("enhancementLevel"),
      price: field.expose("price", { type: SafeIntegerRef }),
      timestamp: field.expose("timestamp", { type: SafeIntegerRef }),
      registeredAt: field.field({
        type: DateTimeRef,
        resolve: (registration) => {
          const registeredAt = dateTimeFromEpochSeconds(registration.timestamp);
          if (registeredAt === null) throw new TypeError("Registration timestamp must be positive");
          return registeredAt;
        },
      }),
    }),
  });

  const MarketRef = builder.objectRef<MarketView>("Market").implement({
    fields: (field) => ({
      region: field.expose("region", { type: MarketRegionRef }),
      locale: field.expose("locale", { type: ItemLocaleRef }),
      observedAt: field.field({
        type: DateTimeRef,
        resolve: (market) => market.observation.value(),
      }),
      items: field.field({
        type: [MarketItemRef],
        nullable: true,
        args: { ids: field.arg.idList({ required: true }) },
        resolve: (market, arguments_, context) => {
          const itemIds = arguments_.ids.map(positiveItemId);
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
        args: { category: field.arg({ type: MarketCategoryInputRef, required: false }) },
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
    fields: (field) => ({
      market: field.field({
        type: MarketRef,
        args: {
          region: field.arg({ type: MarketRegionRef, required: true }),
          locale: field.arg({ type: ItemLocaleRef, required: true, defaultValue: "EN" }),
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
    throw new GraphQLError(`Market summary batch exceeds the ${MARKET_SUMMARY_BATCH_LIMIT}-Item limit`, {
      extensions: { code: "QUERY_BUDGET_EXCEEDED" },
    });
  }

  const observation = observationFor(context, region, locale);
  let summaries: readonly MarketSummary[];
  try {
    summaries = await observation.beforeRead(() => context.reader.readSummaries({ region, locale, itemIds }));
  } catch (error: unknown) {
    if (error instanceof MarketSummaryBudgetExceededError) {
      throw new GraphQLError("Market summary operation exceeds the six-request limit", {
        extensions: { code: "QUERY_BUDGET_EXCEEDED" },
      });
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
