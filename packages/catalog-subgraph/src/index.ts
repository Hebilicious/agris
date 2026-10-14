import { printSubgraphSchema } from "@apollo/subgraph";
import SchemaBuilder from "@pothos/core";
import { positiveItemId } from "@agris/pearl-abyss/item-id";
import { PEARL_ABYSS_ITEM_LOCALE_DESCRIPTIONS, type PearlAbyssItemLocale } from "@agris/pearl-abyss/locales";
import DirectivePlugin from "@pothos/plugin-directives";
import FederationPlugin from "@pothos/plugin-federation";
import { GraphQLError } from "graphql";
import { createYoga, maskError as maskWithYoga } from "graphql-yoga";

export {
  catalogArtifactMetadata,
  catalogItem,
  catalogItemAt,
  catalogItemPosition,
  type CatalogArtifactMetadata,
  type CatalogItem,
} from "./catalog.js";
import { catalogArtifactMetadata, catalogItem, catalogItemAt } from "./catalog.js";
import {
  catalogItemNameSearch,
  type CatalogItemNameSearch,
  type CatalogItemNameSearchExecution,
  type CatalogItemNameSearchFailure,
} from "./item-name-search.js";

export type ItemLocale = PearlAbyssItemLocale;

// The market subgraph defines `Query` and `ItemLocale` too. Composition keeps one description for each, so both
// subgraphs give the same text; `schema:check` fails when the two differ.
const QUERY_DESCRIPTION = "Read-only queries over the Central Market and the item catalog.";
const ITEM_LOCALE_DESCRIPTION = "A language for item names. Prices and counts are the same in every language.";

export interface CatalogSubgraphRuntime {
  readonly schema: ReturnType<typeof createCatalogSchema>;
  readonly sdl: string;
  readonly fetch: (request: Request) => Promise<Response>;
}

export type CatalogSearchDurationBucket = "lte-0.25ms" | "lte-1ms" | "lte-5ms" | "gt-5ms";
export type CatalogSearchFoldedQueryLengthBucket = "0-2" | "3-8" | "9-16" | "17-32" | "33-64" | "65+";
export type CatalogSearchCountBucket = "0" | "1-10" | "11-100" | "101-1000" | "1001+";

interface CatalogSearchTelemetryBase {
  readonly event: "catalog-item-name-search";
  readonly artifactChecksumIdentifier: string;
  readonly catalogVersion: 1;
  readonly count: 1;
  readonly durationBucket?: CatalogSearchDurationBucket;
  readonly locale: ItemLocale;
}

export interface CatalogSearchAcceptedTelemetryEvent extends CatalogSearchTelemetryBase {
  readonly outcome: "accepted";
  readonly foldedQueryLengthBucket: CatalogSearchFoldedQueryLengthBucket;
  readonly candidateCountBucket: CatalogSearchCountBucket;
  readonly returnedCount: number;
  readonly returnedCountBucket: CatalogSearchCountBucket;
  readonly totalCount: number;
}

export interface CatalogSearchRejectedTelemetryEvent extends CatalogSearchTelemetryBase {
  readonly outcome: "rejected";
  readonly errorCategory: "query-length" | "first";
  readonly foldedQueryLengthBucket: CatalogSearchFoldedQueryLengthBucket;
  readonly candidateCountBucket: "0";
  readonly returnedCountBucket: "0";
}

export interface CatalogSearchUnexpectedTelemetryEvent extends CatalogSearchTelemetryBase {
  readonly outcome: "error";
  readonly errorCategory: "unexpected";
  readonly foldedQueryLengthBucket: "unavailable";
  readonly candidateCountBucket: "unavailable";
  readonly returnedCountBucket: "0";
}

export type CatalogSearchTelemetryEvent =
  | CatalogSearchAcceptedTelemetryEvent
  | CatalogSearchRejectedTelemetryEvent
  | CatalogSearchUnexpectedTelemetryEvent;

export interface CatalogSearchTelemetry {
  record(event: CatalogSearchTelemetryEvent): void;
}

export interface CatalogSearchClock {
  nowMilliseconds(): number;
}

export interface CatalogSubgraphInput {
  readonly searchTelemetry?: CatalogSearchTelemetry;
  readonly searchClock?: CatalogSearchClock;
  /** The item-name search over the bundled artifact; tests replace it to make a search fail. */
  readonly itemNameSearch?: CatalogItemNameSearch;
}

interface CatalogItemView {
  readonly id: string;
  readonly itemId: number;
  readonly locale: ItemLocale;
  readonly name: string | null;
  readonly grade: number | null;
}

interface CatalogItemSearchView {
  readonly locale: ItemLocale;
  readonly itemPositions: readonly number[];
  readonly totalCount: number;
}

interface ItemReference {
  readonly id: string;
  readonly locale: ItemLocale;
}

interface SchemaTypes {
  DefaultFieldNullability: false;
}

const defaultSearchTelemetry: CatalogSearchTelemetry = {
  record: (event) => console.info(event),
};

const defaultSearchClock: CatalogSearchClock = {
  nowMilliseconds: () => performance.now(),
};

export function createCatalogSubgraph(input: CatalogSubgraphInput = {}): CatalogSubgraphRuntime {
  const schema = createCatalogSchema({
    searchTelemetry: input.searchTelemetry ?? defaultSearchTelemetry,
    searchClock: input.searchClock ?? defaultSearchClock,
    itemNameSearch: input.itemNameSearch ?? catalogItemNameSearch,
  });
  const yoga = createYoga({
    schema,
    graphqlEndpoint: "/graphql",
    graphiql: false,
    landingPage: false,
    logging: false,
    maskedErrors: { maskError: maskCatalogError },
  });
  return {
    schema,
    sdl: printSubgraphSchema(schema),
    fetch: (request) => Promise.resolve(yoga.fetch(request)),
  };
}

interface CatalogSchemaInput {
  readonly searchTelemetry: CatalogSearchTelemetry;
  readonly searchClock: CatalogSearchClock;
  readonly itemNameSearch: CatalogItemNameSearch;
}

const INTERNAL_ERROR_MESSAGE = "The catalog subgraph could not answer this field.";

/**
 * The errors `badUserInput` made. The mask recognizes them by identity rather than by class, because graphql-js can
 * wrap an error in a `GraphQLError` from another copy of graphql than the one this module imports.
 */
const CATALOG_ERRORS = new WeakSet<Error>();

/** A query mistake a caller may read: its message says what to change. */
function badUserInput(message: string): GraphQLError {
  const error = new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
  CATALOG_ERRORS.add(error);
  return error;
}

/** An item ID from the caller, or a `BAD_USER_INPUT` error that says what is wrong with it. */
function clientItemId(value: string): number {
  try {
    return positiveItemId(value);
  } catch (error: unknown) {
    if (error instanceof TypeError) throw badUserInput(error.message);
    throw error;
  }
}

/**
 * The catalog subgraph's error mask. An error from `badUserInput` passes, wherever graphql-js wrapped it. Everything
 * else goes through Yoga's own mask, which passes the errors graphql-js raises about the request itself (they describe
 * only the public schema) and replaces any other with `INTERNAL_SERVER_ERROR` and one fixed message, keeping its
 * location and path. It never adds the original error, whatever `NODE_ENV` says.
 */
function maskCatalogError(error: unknown): Error {
  if (wrapsCatalogError(error)) return error;
  return maskWithYoga(error, INTERNAL_ERROR_MESSAGE, false);
}

function wrapsCatalogError(error: unknown): error is Error {
  let current: unknown = error;
  while (current instanceof Error) {
    if (CATALOG_ERRORS.has(current)) return true;
    current = "originalError" in current ? current.originalError : undefined;
  }
  return false;
}

function createCatalogSchema(input: CatalogSchemaInput) {
  const builder = new SchemaBuilder<SchemaTypes>({
    defaultFieldNullability: false,
    plugins: [DirectivePlugin, FederationPlugin],
  });
  const ItemLocaleRef = builder.enumType("ItemLocale", {
    description: ITEM_LOCALE_DESCRIPTION,
    values: PEARL_ABYSS_ITEM_LOCALE_DESCRIPTIONS,
  });
  const ItemRef = builder.objectRef<CatalogItemView>("Item").implement({
    description: "A Black Desert item, named in one language.",
    fields: (field) => ({
      id: field.exposeID("id", { description: "The game's item ID: a positive whole number, as a string." }),
      locale: field.expose("locale", { type: ItemLocaleRef, description: "The language of `name`." }),
      name: field.exposeString("name", {
        nullable: true,
        description: "The item's name as the game shows it. Null when the ID is not a known item.",
      }),
      grade: field.exposeInt("grade", {
        nullable: true,
        description: "The item's grade, a whole number from 0 up. Null when the ID is not a known item.",
      }),
    }),
  });
  const ItemSearchResultRef = builder.objectRef<CatalogItemSearchView>("ItemSearchResult").implement({
    description: "The items whose name matches a `searchItems` query.",
    fields: (field) => ({
      items: field.field({
        type: [ItemRef],
        description:
          "Up to `first` matches: exact names first, then names that start with the query, then the rest, each group " +
          "in name order.",
        resolve: (searchResult) =>
          searchResult.itemPositions.map((position) => {
            const item = catalogItemAt(searchResult.locale, position);
            return catalogItemView(searchResult.locale, item.itemId, item.name, item.grade);
          }),
      }),
      totalCount: field.exposeInt("totalCount", {
        description: "How many items match in total, which can be more than `items` holds.",
      }),
    }),
  });
  builder.asEntity(ItemRef, {
    key: builder.selection<ItemReference>("id locale"),
    resolveReference: (reference) => {
      const itemId = clientItemId(reference.id);
      return catalogItemView(reference.locale, itemId);
    },
  });
  builder.queryType({
    description: QUERY_DESCRIPTION,
    fields: (field) => ({
      item: field.field({
        type: ItemRef,
        nullable: true,
        description: "One item by ID. Null when the ID is not a known item.",
        args: {
          id: field.arg.id({ required: true, description: "The item ID: a positive whole number, as a string." }),
          locale: field.arg({
            type: ItemLocaleRef,
            required: true,
            defaultValue: "EN",
            description: "The language for the item's name.",
          }),
        },
        resolve: (_root, arguments_) => {
          const itemId = clientItemId(arguments_.id);
          const locale = arguments_.locale ?? "EN";
          const item = catalogItem(locale, itemId);
          return item === null ? null : catalogItemView(locale, itemId, item.name, item.grade);
        },
      }),
      items: field.field({
        type: [ItemRef],
        description:
          "Items by ID, in the order given, duplicates included. An unknown ID still returns an item, with null " +
          "`name` and `grade`.",
        args: {
          ids: field.arg.idList({ required: true, description: "Item IDs: positive whole numbers, as strings." }),
          locale: field.arg({
            type: ItemLocaleRef,
            required: true,
            defaultValue: "EN",
            description: "The language for the items' names.",
          }),
        },
        resolve: (_root, arguments_) => {
          const itemIds = arguments_.ids.map(clientItemId);
          const locale = arguments_.locale ?? "EN";
          return itemIds.map((itemId) => catalogItemView(locale, itemId));
        },
      }),
      searchItems: field.field({
        type: ItemSearchResultRef,
        description:
          "Items whose name contains `query`, ignoring case, accents, spaces and punctuation: `blackstone` finds " +
          '"Black Stone".',
        args: {
          query: field.arg.string({
            required: true,
            description: "The text to find: at least 3 characters, not counting spaces and punctuation.",
          }),
          locale: field.arg({
            type: ItemLocaleRef,
            required: true,
            description: "The language whose names are searched and returned.",
          }),
          first: field.arg.int({
            required: true,
            defaultValue: 50,
            description: "How many matches to return, from 1 to 100.",
          }),
        },
        resolve: (_root, arguments_) => {
          const startedAt = readSearchClock(input.searchClock);
          let execution: CatalogItemNameSearchExecution;
          try {
            execution = input.itemNameSearch.searchWithMetrics({
              locale: arguments_.locale,
              query: arguments_.query,
              first: arguments_.first ?? 50,
            });
          } catch (error) {
            recordSearchTelemetry(input.searchTelemetry, {
              ...searchTelemetryBase(arguments_.locale, startedAt, input.searchClock),
              outcome: "error",
              errorCategory: "unexpected",
              foldedQueryLengthBucket: "unavailable",
              candidateCountBucket: "unavailable",
              returnedCountBucket: "0",
            });
            throw error;
          }

          const result = execution.result;
          if (!result.ok) {
            recordSearchTelemetry(
              input.searchTelemetry,
              rejectedSearchTelemetry(
                result,
                execution.foldedQueryLength,
                arguments_.locale,
                startedAt,
                input.searchClock,
              ),
            );
            throw badSearchInput(result);
          }

          recordSearchTelemetry(input.searchTelemetry, {
            ...searchTelemetryBase(arguments_.locale, startedAt, input.searchClock),
            outcome: "accepted",
            foldedQueryLengthBucket: foldedQueryLengthBucket(execution.foldedQueryLength),
            candidateCountBucket: countBucket(execution.candidateCount),
            returnedCount: result.itemPositions.length,
            returnedCountBucket: countBucket(result.itemPositions.length),
            totalCount: result.totalCount,
          });
          return {
            locale: arguments_.locale,
            itemPositions: result.itemPositions,
            totalCount: result.totalCount,
          };
        },
      }),
    }),
  });
  return builder.toSubGraphSchema({ linkUrl: "https://specs.apollo.dev/federation/v2.6" });
}

function rejectedSearchTelemetry(
  failure: CatalogItemNameSearchFailure,
  foldedQueryLength: number,
  locale: ItemLocale,
  startedAt: number | null,
  clock: CatalogSearchClock,
): CatalogSearchRejectedTelemetryEvent {
  const base = searchTelemetryBase(locale, startedAt, clock);
  return {
    ...base,
    outcome: "rejected",
    errorCategory: failure.code === "QUERY_LENGTH_OUT_OF_RANGE" ? "query-length" : "first",
    foldedQueryLengthBucket: foldedQueryLengthBucket(foldedQueryLength),
    candidateCountBucket: "0",
    returnedCountBucket: "0",
  };
}

function badSearchInput(failure: CatalogItemNameSearchFailure): GraphQLError {
  const message =
    failure.code === "QUERY_LENGTH_OUT_OF_RANGE"
      ? `Folded Item Name query length must be between ${failure.minimum} and ${failure.maximum} code points`
      : `first must be between ${failure.minimum} and ${failure.maximum}`;
  return badUserInput(message);
}

function searchTelemetryBase(
  locale: ItemLocale,
  startedAt: number | null,
  clock: CatalogSearchClock,
): CatalogSearchTelemetryBase {
  const completedAt = readSearchClock(clock);
  const elapsedMilliseconds = startedAt === null || completedAt === null ? null : Math.max(0, completedAt - startedAt);
  const base: CatalogSearchTelemetryBase = {
    event: "catalog-item-name-search",
    artifactChecksumIdentifier: catalogArtifactMetadata.sourceCatalogChecksums[locale],
    catalogVersion: catalogArtifactMetadata.version,
    count: 1,
    locale,
  };
  if (elapsedMilliseconds === null) return base;
  return { ...base, durationBucket: durationBucket(elapsedMilliseconds) };
}

function foldedQueryLengthBucket(length: number): CatalogSearchFoldedQueryLengthBucket {
  if (length <= 2) return "0-2";
  if (length <= 8) return "3-8";
  if (length <= 16) return "9-16";
  if (length <= 32) return "17-32";
  if (length <= 64) return "33-64";
  return "65+";
}

function countBucket(count: number): CatalogSearchCountBucket {
  if (count === 0) return "0";
  if (count <= 10) return "1-10";
  if (count <= 100) return "11-100";
  if (count <= 1_000) return "101-1000";
  return "1001+";
}

function readSearchClock(clock: CatalogSearchClock): number | null {
  try {
    const value = clock.nowMilliseconds();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function durationBucket(elapsedMilliseconds: number): CatalogSearchDurationBucket {
  if (elapsedMilliseconds <= 0.25) return "lte-0.25ms";
  if (elapsedMilliseconds <= 1) return "lte-1ms";
  if (elapsedMilliseconds <= 5) return "lte-5ms";
  return "gt-5ms";
}

function recordSearchTelemetry(telemetry: CatalogSearchTelemetry, event: CatalogSearchTelemetryEvent): void {
  try {
    telemetry.record(event);
  } catch {
    // Search results must not depend on an observational telemetry sink.
  }
}

function catalogItemView(locale: ItemLocale, itemId: number, knownName?: string, knownGrade?: number): CatalogItemView {
  const item = knownName === undefined || knownGrade === undefined ? catalogItem(locale, itemId) : null;
  return {
    id: String(itemId),
    itemId,
    locale,
    name: knownName ?? item?.name ?? null,
    grade: knownGrade ?? item?.grade ?? null,
  };
}
