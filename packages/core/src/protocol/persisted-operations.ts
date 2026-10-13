import type { GraphQLSchema } from "graphql";

import { validateQueryDocument } from "./document.js";
import { isPersistedOperationId } from "./persisted-get.js";
import type { PersistedOperationDefinition } from "./types.js";

/**
 * Refuse an approved-operation list the gateway could not serve: each entry must be one named query that is valid
 * against the client schema, under the SHA-256 hash of its canonical document.
 */
export async function validatePersistedOperations(
  schema: GraphQLSchema,
  definitions: Readonly<Record<string, PersistedOperationDefinition>>,
): Promise<void> {
  for (const [id, definition] of Object.entries(definitions)) {
    if (!isPersistedOperationId(id)) {
      throw new TypeError(`Persisted operation ID must be a lowercase SHA-256 hash: ${id}`);
    }
    const result = await validateQueryDocument(schema, definition.document, null);
    if (!result.ok) throw new TypeError(`Invalid persisted operation ${id}: ${result.message}`);
    if (result.value.operationName === null) {
      throw new TypeError(`Persisted operation must be named: ${id}`);
    }
    if (result.value.documentHash !== id) {
      throw new TypeError(`Persisted operation hash does not match its canonical document: ${id}`);
    }
  }
}

/**
 * BOUNDARY: Read a persisted-operations manifest (`{ version, operations: { [id]: { name, document } } }`) as unknown,
 * keeping each document under its ID, and refuse one whose entries do not all check out.
 */
export function readPersistedOperationDocuments(manifest: unknown): ReadonlyMap<string, string> {
  const operations = isObject(manifest) ? manifest.operations : undefined;
  if (!isObject(operations)) throw new TypeError("The persisted-operations manifest has no operations");
  const documents = new Map<string, string>();
  for (const [id, operation] of Object.entries(operations)) {
    const document = isObject(operation) ? operation.document : undefined;
    if (!isPersistedOperationId(id) || typeof document !== "string") {
      throw new TypeError(`The persisted-operations manifest entry ${id} is malformed`);
    }
    documents.set(id, document);
  }
  return documents;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
