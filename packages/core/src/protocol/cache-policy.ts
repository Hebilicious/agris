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

import { DEFAULT_CACHE_FRESHNESS, type CacheFreshnessPolicy, type CoordinateFreshness } from "./cache-freshness.js";
import type { ValidatedDocument } from "./document.js";
import type { GatewayCachePolicy, JsonObject } from "./types.js";

/**
 * Choose how long a successful result may be stored from the coordinates the document selects, under `freshness`.
 *
 * A storable result takes the shortest window among the coordinates it selects. `freshness.minimumSeconds` then raises
 * both its fresh and its stale-while-revalidate window to at least that many seconds; a deployment that must protect
 * Pearl Abyss, such as a shared demo, trades freshness for fewer upstream calls. The floor never makes an uncacheable
 * result storable and never shortens a window.
 *
 * A disabled policy stores nothing, and a coordinate whose fresh window is `0` is never stored, whatever the floor.
 */
export function selectGatewayCachePolicy(
  schema: GraphQLSchema,
  document: ValidatedDocument,
  variables: JsonObject,
  freshness: CacheFreshnessPolicy = DEFAULT_CACHE_FRESHNESS,
): GatewayCachePolicy {
  if (!freshness.enabled) return { mode: "no-store" };
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
        if (freshness.neverStored.includes(coordinate)) bypassCache = true;
        const window = Object.hasOwn(freshness.coordinates, coordinate) ? freshness.coordinates[coordinate] : undefined;
        if (window !== undefined && window.maxAgeSeconds === 0) bypassCache = true;
        else if (window !== undefined) selectFreshness(window);

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
    maxAgeSeconds: Math.max(shortestMaxAge, freshness.minimumSeconds),
    staleWhileRevalidateSeconds: Math.max(shortestRevalidation, freshness.minimumSeconds),
    staleIfErrorSeconds: freshness.staleIfErrorSeconds,
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
