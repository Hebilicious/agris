import {
  getVariableValues,
  Kind,
  parse,
  print,
  specifiedRules,
  stripIgnoredCharacters,
  validate,
  type DocumentNode,
  type GraphQLSchema,
  type OperationDefinitionNode,
} from "graphql";

import { canonicalizeJsonObject } from "./canonical-json.js";
import { sha256Hex } from "./identity.js";
import type { JsonObject } from "./types.js";

export interface ValidatedDocument {
  readonly canonicalDocument: string;
  readonly documentHash: string;
  readonly documentNode: DocumentNode;
  readonly operation: OperationDefinitionNode;
  readonly operationName: string | null;
}

export interface ValidatedVariables {
  readonly canonicalText: string;
  readonly value: JsonObject;
}

export function canonicalizeGraphqlDocument(documentNode: DocumentNode): string {
  return stripIgnoredCharacters(print(documentNode));
}

export type DocumentValidationResult =
  | { readonly ok: true; readonly value: ValidatedDocument }
  | { readonly ok: false; readonly kind: "document" | "operation"; readonly message: string };

export type VariableValidationResult =
  | { readonly ok: true; readonly value: ValidatedVariables }
  | { readonly ok: false; readonly message: string };

export async function validateQueryDocument(
  schema: GraphQLSchema,
  source: string,
  requestedOperationName: string | null,
): Promise<DocumentValidationResult> {
  let documentNode: DocumentNode;
  try {
    documentNode = parse(source);
  } catch {
    return { ok: false, kind: "document", message: "The GraphQL document is malformed" };
  }

  const operations = documentNode.definitions.filter(
    (definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (operations.length !== 1) {
    return { ok: false, kind: "document", message: "Exactly one GraphQL operation is required" };
  }
  if (documentNode.definitions.some((definition) => !isExecutableDefinition(definition.kind))) {
    return { ok: false, kind: "document", message: "Only executable GraphQL definitions are accepted" };
  }

  const operation = operations[0];
  if (operation === undefined) {
    return { ok: false, kind: "document", message: "Exactly one GraphQL operation is required" };
  }
  if (operation.operation !== "query") {
    return { ok: false, kind: "operation", message: "Only GraphQL query operations are accepted" };
  }

  const operationName = operation.name?.value ?? null;
  if (requestedOperationName !== null && requestedOperationName !== operationName) {
    return { ok: false, kind: "document", message: "The requested operation name does not match the query" };
  }

  const validationErrors = validate(schema, documentNode, specifiedRules);
  if (validationErrors.length > 0) {
    return { ok: false, kind: "document", message: "The GraphQL query is invalid for this schema" };
  }

  const canonicalDocument = canonicalizeGraphqlDocument(documentNode);
  return {
    ok: true,
    value: {
      canonicalDocument,
      documentHash: await sha256Hex(canonicalDocument),
      documentNode,
      operation,
      operationName,
    },
  };
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ export function validateVariables(
  schema: GraphQLSchema,
  document: ValidatedDocument,
  variables: unknown,
): VariableValidationResult {
  let rawVariables: JsonObject;
  try {
    rawVariables = canonicalizeJsonObject(variables).value;
  } catch {
    return { ok: false, message: "GraphQL variables must be a JSON object" };
  }

  const coercion = getVariableValues(schema, document.operation.variableDefinitions ?? [], rawVariables);
  if ("errors" in coercion) {
    return { ok: false, message: "GraphQL variables do not satisfy the selected query" };
  }

  try {
    const canonical = canonicalizeJsonObject(coercion.coerced);
    return { ok: true, value: { canonicalText: canonical.text, value: canonical.value } };
  } catch {
    return { ok: false, message: "GraphQL variables did not normalize to JSON values" };
  }
}

function isExecutableDefinition(kind: string): boolean {
  return kind === Kind.OPERATION_DEFINITION || kind === Kind.FRAGMENT_DEFINITION;
}
