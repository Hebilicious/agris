import { Exit, Schema, SchemaTransformation } from "effect";
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

/** How large a public query may be by default; private callers send only their own approved documents and take none. */
export const PUBLIC_DOCUMENT_LIMITS: GatewayDocumentLimits = Object.freeze({
  maxDepth: 8,
  maxFields: 150,
  maxAliases: 15,
  maxTypeExpansions: 2,
});

/**
 * The public gateway's query limit settings, one plain-text variable per limit. Each takes a whole number; `0` turns
 * that limit off. The gateway refuses any other `QUERY_` variable.
 */
export const QUERY_LIMIT_SETTING = Object.freeze({
  maxDepth: "QUERY_MAX_DEPTH",
  maxFields: "QUERY_MAX_FIELDS",
  maxAliases: "QUERY_MAX_ALIASES",
  maxTypeExpansions: "QUERY_MAX_TYPE_EXPANSIONS",
} satisfies Record<keyof GatewayDocumentLimits, string>);

const QUERY_LIMIT_KEYS = Object.keys(QUERY_LIMIT_SETTING) as readonly (keyof typeof QUERY_LIMIT_SETTING)[];
const decodeLimit = Schema.decodeUnknownExit(
  Schema.Union([
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u)).pipe(
      Schema.decodeTo(Schema.Int, SchemaTransformation.numberFromString),
    ),
  ]),
);

/**
 * BOUNDARY: The public document limits a gateway's bindings select: `PUBLIC_DOCUMENT_LIMITS` with each `QUERY_*`
 * setting applied, where `0` lifts that limit. It throws a `TypeError` naming every value that is not a non-negative
 * whole number and every `QUERY_` binding that is not a limit.
 */
export function documentLimitsFromBindings(bindings: object): GatewayDocumentLimits {
  const values = new Map(Object.entries(bindings).filter(([name]) => name.startsWith("QUERY_")));
  if (values.size === 0) return PUBLIC_DOCUMENT_LIMITS;
  const known: ReadonlySet<string> = new Set(Object.values(QUERY_LIMIT_SETTING));
  const problems = [...values.keys()].filter((name) => !known.has(name)).map((name) => `${name} is not a query limit`);
  const limits: Record<keyof GatewayDocumentLimits, number> = {
    maxDepth: PUBLIC_DOCUMENT_LIMITS.maxDepth,
    maxFields: PUBLIC_DOCUMENT_LIMITS.maxFields,
    maxAliases: PUBLIC_DOCUMENT_LIMITS.maxAliases,
    maxTypeExpansions: PUBLIC_DOCUMENT_LIMITS.maxTypeExpansions ?? Number.POSITIVE_INFINITY,
  };
  for (const key of QUERY_LIMIT_KEYS) {
    const name = QUERY_LIMIT_SETTING[key];
    if (!values.has(name)) continue;
    const decoded = decodeLimit(values.get(name));
    if (Exit.isFailure(decoded)) problems.push(`${name} must be a non-negative whole number, 0 for no limit`);
    else limits[key] = decoded.value === 0 ? Number.POSITIVE_INFINITY : decoded.value;
  }
  if (problems.length > 0) throw new TypeError(`The gateway's query limits are invalid: ${problems.join("; ")}`);
  return Object.freeze(limits);
}

/**
 * The limits an introspection-only query meets on a gateway with `limits`: `INTROSPECTION_DOCUMENT_LIMITS`, except that
 * a limit the deployment lifted is lifted for introspection too.
 */
export function introspectionLimitsFor(limits: GatewayDocumentLimits): GatewayDocumentLimits {
  const lifted = (value: number | undefined) => value === Number.POSITIVE_INFINITY;
  return Object.freeze({
    maxDepth: lifted(limits.maxDepth) ? Number.POSITIVE_INFINITY : INTROSPECTION_DOCUMENT_LIMITS.maxDepth,
    maxFields: lifted(limits.maxFields) ? Number.POSITIVE_INFINITY : INTROSPECTION_DOCUMENT_LIMITS.maxFields,
    maxAliases: lifted(limits.maxAliases) ? Number.POSITIVE_INFINITY : INTROSPECTION_DOCUMENT_LIMITS.maxAliases,
    maxTypeExpansions: lifted(limits.maxTypeExpansions)
      ? Number.POSITIVE_INFINITY
      : (INTROSPECTION_DOCUMENT_LIMITS.maxTypeExpansions ?? Number.POSITIVE_INFINITY),
  });
}

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
