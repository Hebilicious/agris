import { Kind, type FragmentDefinitionNode, type SelectionSetNode } from "graphql";

import type { ValidatedDocument } from "./document.js";

/**
 * How large one query may be once its fragments are expanded. A public caller can send any document the schema
 * accepts, so these bound the work one request can ask for before the invocation budgets meet it.
 */
export interface GatewayDocumentLimits {
  /** The deepest chain of nested fields, counting the root field as depth 1. */
  readonly maxDepth: number;
  /** Every selected field, `__typename` included, with each fragment spread counted where it is spread. */
  readonly maxFields: number;
  /** Every field selected under an alias. */
  readonly maxAliases: number;
  /**
   * How many type-listing introspection fields (`types`, `fields`, `inputFields`, `interfaces`, `possibleTypes`) one
   * path may pass through. Each multiplies the result by the size of the schema, so this bounds what an introspection
   * query returns, not only what it asks for.
   */
  readonly maxTypeExpansions?: number;
}

/**
 * The limits for an operation that selects only introspection fields at its root. GraphiQL's introspection query, with
 * every option it enables, selects 230 fields 15 deep and lists types twice on a path (`types`, then `fields`); this
 * admits it and refuses the recursive `fields { type { fields } }` shapes that grow with every level.
 */
export const INTROSPECTION_DOCUMENT_LIMITS: GatewayDocumentLimits = Object.freeze({
  maxDepth: 16,
  maxFields: 300,
  maxAliases: 15,
  maxTypeExpansions: 2,
});

const TYPE_EXPANDING_FIELDS: ReadonlySet<string> = new Set([
  "types",
  "fields",
  "inputFields",
  "interfaces",
  "possibleTypes",
]);

export type DocumentLimitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly limit: keyof GatewayDocumentLimits; readonly message: string };

/**
 * Measure a validated document against the limits, stopping at the first one it exceeds. Validation has already
 * rejected fragment cycles, so expanding spreads terminates; counting stops as soon as a limit is crossed, so a
 * document that spreads one fragment many times costs no more than the limit to measure.
 */
export function checkDocumentLimits(document: ValidatedDocument, limits: GatewayDocumentLimits): DocumentLimitResult {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.documentNode.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
  }
  const maxTypeExpansions = limits.maxTypeExpansions ?? Number.POSITIVE_INFINITY;

  const counts = { fields: 0, aliases: 0 };
  const visit = (
    selectionSet: SelectionSetNode,
    depth: number,
    typeExpansions: number,
  ): keyof GatewayDocumentLimits | null => {
    for (const selection of selectionSet.selections) {
      let exceeded: keyof GatewayDocumentLimits | null = null;
      if (selection.kind === Kind.FIELD) {
        if (depth > limits.maxDepth) return "maxDepth";
        counts.fields += 1;
        if (counts.fields > limits.maxFields) return "maxFields";
        if (selection.alias !== undefined) counts.aliases += 1;
        if (counts.aliases > limits.maxAliases) return "maxAliases";
        const expansions = typeExpansions + (TYPE_EXPANDING_FIELDS.has(selection.name.value) ? 1 : 0);
        if (expansions > maxTypeExpansions) return "maxTypeExpansions";
        if (selection.selectionSet !== undefined) exceeded = visit(selection.selectionSet, depth + 1, expansions);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        exceeded = visit(selection.selectionSet, depth, typeExpansions);
      } else {
        const fragment = fragments.get(selection.name.value);
        if (fragment !== undefined) exceeded = visit(fragment.selectionSet, depth, typeExpansions);
      }
      if (exceeded !== null) return exceeded;
    }
    return null;
  };

  const exceeded = visit(document.operation.selectionSet, 1, 0);
  switch (exceeded) {
    case null:
      return { ok: true };
    case "maxDepth":
      return { ok: false, limit: exceeded, message: `The GraphQL query nests deeper than ${limits.maxDepth} fields` };
    case "maxFields":
      return { ok: false, limit: exceeded, message: `The GraphQL query selects more than ${limits.maxFields} fields` };
    case "maxAliases":
      return { ok: false, limit: exceeded, message: `The GraphQL query uses more than ${limits.maxAliases} aliases` };
    case "maxTypeExpansions":
      return {
        ok: false,
        limit: exceeded,
        message: `The GraphQL query lists types more than ${maxTypeExpansions} times on one path`,
      };
  }
}

/** Whether the operation selects only introspection fields (`__schema`, `__type`, `__typename`) at its root. */
export function isIntrospectionOnly(document: ValidatedDocument): boolean {
  return document.operation.selectionSet.selections.every(
    (selection) => selection.kind === Kind.FIELD && selection.name.value.startsWith("__"),
  );
}
