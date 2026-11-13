import { isPersistedOperationId } from "./persisted-get.js";
import type { GatewayProtocolResult } from "./types.js";

export { PUBLIC_DOCUMENT_LIMITS } from "./document-limits.js";

/** The largest query string a public GET may carry, the same bound as a POST body. */
const MAXIMUM_PUBLIC_GET_SEARCH_BYTES = 64 * 1_024;

const PUBLIC_GET_PARAMETERS = new Set(["query", "id", "variables", "operationName", "extensions"]);

export type PublicGetBodyResult =
  | { readonly ok: true; readonly bodyText: string }
  | Extract<GatewayProtocolResult, { readonly ok: false }>;

/**
 * Turn a public GraphQL GET into the POST body the gateway protocol validates, so both methods meet one set of rules and
 * share one cache identity. The query string carries exactly one of `query` or `id` (a persisted operation the
 * deployment knows), plus optional `variables` and `extensions` (JSON) and `operationName`, each at most once. As
 * GraphQL over HTTP asks, a parameter given as the empty string counts as absent.
 *
 * The private Service Binding protocol accepts only `id` and `variables`; see `parseCanonicalPersistedGet`.
 */
export function publicGetBody(search: string, persistedDocuments: ReadonlyMap<string, string>): PublicGetBodyResult {
  if (search.length > MAXIMUM_PUBLIC_GET_SEARCH_BYTES)
    return invalidRequest("GraphQL request URL exceeds the accepted size");
  const given = [...new URLSearchParams(search)].filter(([, value]) => value !== "");
  const names = given.map(([name]) => name);
  if (names.some((name) => !PUBLIC_GET_PARAMETERS.has(name))) {
    return invalidRequest("GraphQL GET requests accept only query, id, variables, operationName and extensions");
  }
  if (new Set(names).size !== names.length) return invalidRequest("GraphQL GET parameters may appear only once");
  const parameters = new Map(given);

  const id = parameters.get("id");
  const inlineQuery = parameters.get("query");
  if ((id === undefined) === (inlineQuery === undefined)) {
    return invalidRequest("GraphQL GET requests require exactly one of query or id");
  }
  const query = id === undefined ? inlineQuery : isPersistedOperationId(id) ? persistedDocuments.get(id) : undefined;
  if (query === undefined) return invalidRequest("Unknown persisted operation id");

  const variables = jsonParameter(parameters.get("variables"));
  if (!variables.ok) {
    return { ok: false, error: { status: 400, code: "invalid-variables", message: "GraphQL variables must be JSON" } };
  }
  const extensions = jsonParameter(parameters.get("extensions"));
  if (!extensions.ok) return invalidRequest("GraphQL extensions must be JSON");

  return {
    ok: true,
    bodyText: JSON.stringify({
      query,
      variables: variables.value,
      operationName: parameters.get("operationName"),
      extensions: extensions.value,
    }),
  };
}

/** A JSON parameter's value, or `undefined` when it is absent. */
function jsonParameter(
  text: string | undefined,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (text === undefined) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function invalidRequest(message: string): Extract<GatewayProtocolResult, { readonly ok: false }> {
  return { ok: false, error: { status: 400, code: "invalid-request", message } };
}
