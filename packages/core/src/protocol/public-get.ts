import { isPersistedOperationId } from "./persisted-get.js";
import type { GatewayDocumentLimits } from "./document-limits.js";
import type { GatewayProtocolResult } from "./types.js";

/** How large a public query may be; private callers send only their own approved documents and take no limits. */
export const PUBLIC_DOCUMENT_LIMITS: GatewayDocumentLimits = Object.freeze({
  maxDepth: 8,
  maxFields: 150,
  maxAliases: 15,
  maxTypeExpansions: 2,
});

/** The largest query string a public GET may carry, the same bound as a POST body. */
const MAXIMUM_PUBLIC_GET_SEARCH_BYTES = 64 * 1_024;

const PUBLIC_GET_PARAMETERS = new Set(["query", "id", "variables", "operationName"]);

export type PublicGetBodyResult =
  | { readonly ok: true; readonly bodyText: string }
  | Extract<GatewayProtocolResult, { readonly ok: false }>;

/**
 * Turn a public GraphQL GET into the POST body the gateway protocol validates, so both methods meet one set of rules and
 * share one cache identity. The query string carries exactly one of `query` or `id` (a persisted operation the
 * deployment knows), plus optional `variables` (JSON) and `operationName`, each at most once.
 *
 * The private Service Binding protocol accepts only `id` and `variables`; see `parseCanonicalPersistedGet`.
 */
export function publicGetBody(search: string, persistedDocuments: ReadonlyMap<string, string>): PublicGetBodyResult {
  if (search.length > MAXIMUM_PUBLIC_GET_SEARCH_BYTES)
    return invalidRequest("GraphQL request URL exceeds the accepted size");
  const parameters = new URLSearchParams(search);
  const names = [...parameters.keys()];
  if (names.some((name) => !PUBLIC_GET_PARAMETERS.has(name))) {
    return invalidRequest("GraphQL GET requests accept only query, id, variables and operationName");
  }
  if (new Set(names).size !== names.length) return invalidRequest("GraphQL GET parameters may appear only once");

  const id = parameters.get("id");
  const inlineQuery = parameters.get("query");
  if ((id === null) === (inlineQuery === null)) {
    return invalidRequest("GraphQL GET requests require exactly one of query or id");
  }
  const query = id === null ? inlineQuery : isPersistedOperationId(id) ? persistedDocuments.get(id) : undefined;
  if (query === undefined || query === null) return invalidRequest("Unknown persisted operation id");

  const variablesText = parameters.get("variables");
  let variables: unknown;
  if (variablesText !== null) {
    try {
      variables = JSON.parse(variablesText);
    } catch {
      return {
        ok: false,
        error: { status: 400, code: "invalid-variables", message: "GraphQL variables must be JSON" },
      };
    }
  }

  return {
    ok: true,
    bodyText: JSON.stringify({ query, variables, operationName: parameters.get("operationName") ?? undefined }),
  };
}

function invalidRequest(message: string): Extract<GatewayProtocolResult, { readonly ok: false }> {
  return { ok: false, error: { status: 400, code: "invalid-request", message } };
}
