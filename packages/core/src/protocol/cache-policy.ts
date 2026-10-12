import {
  getDirectiveValues,
  getNamedType,
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
  isCompositeType,
  isInterfaceType,
  isObjectType,
  Kind,
  type FragmentDefinitionNode,
  type GraphQLCompositeType,
  type GraphQLSchema,
  type SelectionNode,
  type SelectionSetNode,
} from "graphql";

import { MARKET_PRICE_FRESHNESS } from "../freshness.js";

import type { ValidatedDocument } from "./document.js";
import type { GatewayCachePolicy, JsonObject } from "./types.js";

const ONE_DAY_SECONDS = 86_400;

interface CoordinateFreshness {
  /** How long a stored result answers as fresh. */
  readonly maxAgeSeconds: number;
  /** How much longer it answers at once while the edge refreshes it in the background. */
  readonly staleWhileRevalidateSeconds: number;
}

/**
 * Freshness in seconds, named by the selected client-schema coordinate. Market prices follow the end-to-end price
 * policy; everything else stays servable for one more freshness period, at most a day, while it refreshes.
 */
export const SCHEMA_COORDINATE_FRESHNESS = Object.freeze({
  "MarketItem.orderBook": { maxAgeSeconds: 5, staleWhileRevalidateSeconds: 5 },
  "Market.registrations": { maxAgeSeconds: 5, staleWhileRevalidateSeconds: 5 },
  "Market.items": MARKET_PRICE_FRESHNESS.edge,
  "MarketItem.listings": MARKET_PRICE_FRESHNESS.edge,
  "Market.catalog": { maxAgeSeconds: 30, staleWhileRevalidateSeconds: 30 },
  "Market.hotItems": { maxAgeSeconds: 30, staleWhileRevalidateSeconds: 30 },
  "MarketItem.priceHistory": { maxAgeSeconds: 3_600, staleWhileRevalidateSeconds: 3_600 },
  "Query.item": { maxAgeSeconds: 31_536_000, staleWhileRevalidateSeconds: ONE_DAY_SECONDS },
  "Query.items": { maxAgeSeconds: 31_536_000, staleWhileRevalidateSeconds: ONE_DAY_SECONDS },
} as const satisfies Readonly<Record<string, CoordinateFreshness>>);

/** Successful stored results remain available for a day during an upstream failure. */
export const STALE_IF_ERROR_SECONDS = ONE_DAY_SECONDS;

const NO_STORE_SCHEMA_COORDINATES = new Set(["Item.marketSummary", "Query.searchItems"]);

/**
 * Choose how long a successful result may be stored from the coordinates the document selects.
 *
 * `freshnessFloorSeconds`, when given, raises both the fresh and the stale-while-revalidate windows of a storable
 * result to at least that many seconds; a deployment that must protect Pearl Abyss, such as a shared demo, trades
 * freshness for fewer upstream calls. It never makes an uncacheable result storable and never shortens a window.
 */
export function selectGatewayCachePolicy(
  schema: GraphQLSchema,
  document: ValidatedDocument,
  variables: JsonObject,
  freshnessFloorSeconds = 0,
): GatewayCachePolicy {
  const queryType = schema.getQueryType();
  if (queryType === null || queryType === undefined) return { mode: "no-store" };

  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.documentNode.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
  }

  let shortestMaxAge = Number.POSITIVE_INFINITY;
  let shortestRevalidation = Number.POSITIVE_INFINITY;
  let bypassCache = false;
  const selectFreshness = (freshness: CoordinateFreshness): void => {
    shortestMaxAge = Math.min(shortestMaxAge, freshness.maxAgeSeconds);
    shortestRevalidation = Math.min(shortestRevalidation, freshness.staleWhileRevalidateSeconds);
  };

  const visitSelectionSet = (parentType: GraphQLCompositeType, selectionSet: SelectionSetNode): void => {
    for (const selection of selectionSet.selections) {
      if (!isIncluded(selection, variables)) continue;

      if (selection.kind === Kind.FIELD) {
        if (selection.name.value === "__typename" || (!isObjectType(parentType) && !isInterfaceType(parentType))) {
          continue;
        }
        const field = parentType.getFields()[selection.name.value];
        if (field === undefined) continue;
        const coordinate = `${parentType.name}.${selection.name.value}`;
        if (NO_STORE_SCHEMA_COORDINATES.has(coordinate)) bypassCache = true;
        if (isPolicyCoordinate(coordinate)) selectFreshness(SCHEMA_COORDINATE_FRESHNESS[coordinate]);

        const selectedType = getNamedType(field.type);
        if (selection.selectionSet !== undefined && isCompositeType(selectedType)) {
          visitSelectionSet(selectedType, selection.selectionSet);
        }
        continue;
      }

      if (selection.kind === Kind.INLINE_FRAGMENT) {
        const narrowedType = selection.typeCondition?.name.value;
        const selectedType = narrowedType === undefined ? parentType : schema.getType(narrowedType);
        if (selectedType !== undefined && isCompositeType(selectedType)) {
          visitSelectionSet(selectedType, selection.selectionSet);
        }
        continue;
      }

      const fragment = fragments.get(selection.name.value);
      if (fragment === undefined) continue;
      const selectedType = schema.getType(fragment.typeCondition.name.value);
      if (selectedType !== undefined && isCompositeType(selectedType)) {
        visitSelectionSet(selectedType, fragment.selectionSet);
      }
    }
  };

  visitSelectionSet(queryType, document.operation.selectionSet);
  if (bypassCache) return { mode: "no-store" };
  if (shortestMaxAge === Number.POSITIVE_INFINITY) return { mode: "no-store" };
  return {
    mode: "store",
    maxAgeSeconds: Math.max(shortestMaxAge, freshnessFloorSeconds),
    staleWhileRevalidateSeconds: Math.max(shortestRevalidation, freshnessFloorSeconds),
    staleIfErrorSeconds: STALE_IF_ERROR_SECONDS,
  };
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function isIncluded(
  node: SelectionNode,
  variables: JsonObject,
): boolean {
  const skip = getDirectiveValues(GraphQLSkipDirective, node, variables);
  if (skip !== undefined && Reflect.get(skip, "if") === true) return false;
  const include = getDirectiveValues(GraphQLIncludeDirective, node, variables);
  return include === undefined || Reflect.get(include, "if") === true;
}

function isPolicyCoordinate(coordinate: string): coordinate is keyof typeof SCHEMA_COORDINATE_FRESHNESS {
  return Object.hasOwn(SCHEMA_COORDINATE_FRESHNESS, coordinate);
}

/**
 * BOUNDARY: A deployment's freshness floor, from a binding: absent is no floor, otherwise a non-negative whole number
 * of seconds that `selectGatewayCachePolicy` raises every storable window to.
 */
export function parseFreshnessFloorSeconds(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new TypeError("A freshness floor must be a non-negative whole number of seconds");
}
