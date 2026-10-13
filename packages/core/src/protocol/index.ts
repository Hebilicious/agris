import type { GraphQLSchema } from "graphql";

import { applyCacheFreshnessOverride, DEFAULT_CACHE_FRESHNESS, type CacheFreshnessPolicy } from "./cache-freshness.js";
import { selectGatewayCachePolicy } from "./cache-policy.js";
import { operationResultIdentity, syntheticGetKey } from "./identity.js";
export { dispatchGatewayOperation, type GatewayOperationDispatchPort } from "./operation-result.js";
import { validateQueryDocument, validateVariables, type ValidatedDocument } from "./document.js";
import {
  checkDocumentLimits,
  introspectionLimitsFor,
  isIntrospectionOnly,
  PUBLIC_DOCUMENT_LIMITS,
  type GatewayDocumentLimits,
} from "./document-limits.js";
import type {
  GatewayProtocolError,
  GatewayProtocolRequest,
  GatewayProtocolResult,
  GatewayRequestProtocol,
  GatewayRequestProtocolInput,
  NormalizedGatewayRequest,
} from "./types.js";

export { CACHE_POLICY_VERSION, CATALOG_DATA_IDENTITY, operationResultIdentity } from "./identity.js";
export { canonicalizeGraphqlDocument } from "./document.js";
export { sha256Hex } from "./identity.js";
export {
  applyCacheFreshnessOverride,
  CACHE_SETTING,
  CACHE_SETTING_NAMES,
  cacheFreshnessFromBindings,
  cacheFreshnessOverrideFromBindings,
  cacheSettingsOf,
  COORDINATE_CACHE_SETTINGS,
  coordinateSettingStem,
  DEFAULT_CACHE_FRESHNESS,
  NO_STORE_SCHEMA_COORDINATES,
  SCHEMA_COORDINATE_FRESHNESS,
  STALE_IF_ERROR_SECONDS,
  type CacheFreshnessOverride,
  type CacheFreshnessPolicy,
  type CoordinateCacheSettings,
  type CoordinateFreshness,
} from "./cache-freshness.js";
export { classifyGatewayResponse } from "./response-classification.js";
export {
  checkDocumentLimits,
  documentLimitsFromBindings,
  INTROSPECTION_DOCUMENT_LIMITS,
  introspectionLimitsFor,
  isIntrospectionOnly,
  PUBLIC_DOCUMENT_LIMITS,
  QUERY_LIMIT_SETTING,
  type DocumentLimitResult,
  type GatewayDocumentLimits,
} from "./document-limits.js";
export { readPersistedOperationDocuments, validatePersistedOperations } from "./persisted-operations.js";
export { publicGetBody, type PublicGetBodyResult } from "./public-get.js";
export {
  isPersistedOperationId,
  parseCanonicalPersistedGet,
  type CanonicalPersistedGet,
  type CanonicalPersistedGetResult,
} from "./persisted-get.js";
export type {
  GatewayProtocolError,
  GatewayProtocolErrorCode,
  GatewayProtocolRequest,
  GatewayProtocolResult,
  GatewayCachePolicy,
  GatewayCacheStatus,
  GatewayRequestProtocol,
  GatewayRequestProtocolInput,
  GatewayResponseClassification,
  GatewayResponseClassificationInput,
  GatewayResponseRefresh,
  GatewayResponseSource,
  JsonObject,
  JsonValue,
  NormalizedExecutionInput,
  NormalizedGatewayRequest,
  PersistedOperationDefinition,
} from "./types.js";

/**
 * The private Agris Proxy's request protocol: one GraphQL POST, validated against the client schema.
 *
 * Callers reach the proxy only through a Service Binding, and each caller sends only documents from its own
 * approved-operation list, so the proxy holds no copy of that list. Freshness comes from the selected schema
 * coordinates under `input.cacheFreshness`, the default policy unless the deployment configures one.
 */
export function createGatewayRequestProtocol(input: GatewayRequestProtocolInput): GatewayRequestProtocol {
  const freshness = effectiveFreshness(input);
  return {
    normalize: (request) =>
      request.method === "POST"
        ? normalizePost(input, freshness, request)
        : Promise.resolve(failure(405, "invalid-method", "Only GraphQL POST requests are accepted")),
  };
}

/** What a public deployment chooses about its protocol; the rest is fixed for every public gateway. */
export interface PublicGatewayRequestProtocolInput {
  readonly schema: GraphQLSchema;
  readonly cacheFreshness?: CacheFreshnessPolicy;
  /** Shorthand that replaces `cacheFreshness.minimumSeconds`. */
  readonly freshnessFloorSeconds?: number;
  /** The query limits; `PUBLIC_DOCUMENT_LIMITS` when absent. */
  readonly documentLimits?: GatewayDocumentLimits;
}

/**
 * The public gateway's request protocol: the private protocol plus the public document limits, and the
 * GraphQL-over-HTTP `extensions` object that clients such as GraphiQL send. Every public caller, and the website that
 * checks its example queries, builds it here so they cannot disagree about what a public query may be.
 */
export function createPublicGatewayRequestProtocol(input: PublicGatewayRequestProtocolInput): GatewayRequestProtocol {
  return createGatewayRequestProtocol({
    schema: input.schema,
    documentLimits: input.documentLimits ?? PUBLIC_DOCUMENT_LIMITS,
    acceptExtensions: true,
    ...(input.cacheFreshness === undefined ? {} : { cacheFreshness: input.cacheFreshness }),
    ...(input.freshnessFloorSeconds === undefined ? {} : { freshnessFloorSeconds: input.freshnessFloorSeconds }),
  });
}

function effectiveFreshness(input: GatewayRequestProtocolInput): CacheFreshnessPolicy {
  const policy = input.cacheFreshness ?? DEFAULT_CACHE_FRESHNESS;
  return input.freshnessFloorSeconds === undefined
    ? policy
    : applyCacheFreshnessOverride(policy, { minimumSeconds: input.freshnessFloorSeconds });
}

/** The POST body keys each protocol reads; the public one also takes the GraphQL-over-HTTP `extensions`, and ignores it. */
const PRIVATE_BODY_KEYS: ReadonlySet<string> = new Set(["query", "operationName", "variables"]);
const PUBLIC_BODY_KEYS: ReadonlySet<string> = new Set([...PRIVATE_BODY_KEYS, "extensions"]);

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ async function normalizePost(
  input: GatewayRequestProtocolInput,
  freshness: CacheFreshnessPolicy,
  request: GatewayProtocolRequest,
): Promise<GatewayProtocolResult> {
  const { schema } = input;
  if (!isJsonContentType(request.contentType)) {
    return failure(415, "invalid-content-type", "GraphQL POST requests require application/json with UTF-8 charset");
  }
  if (request.searchParams !== "") {
    return failure(400, "invalid-request", "GraphQL POST requests cannot include query parameters");
  }
  if (request.bodyText === null || request.bodyText.trim() === "") {
    return failure(400, "invalid-request", "GraphQL POST requests require one JSON request object");
  }

  let body: unknown;
  try {
    body = JSON.parse(request.bodyText);
  } catch {
    return failure(400, "invalid-request", "The GraphQL POST body is malformed JSON");
  }
  if (!isRecord(body)) {
    return failure(400, "invalid-request", "The GraphQL POST body must be one request object");
  }
  const allowedKeys = input.acceptExtensions === true ? PUBLIC_BODY_KEYS : PRIVATE_BODY_KEYS;
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    return failure(400, "invalid-request", "The GraphQL POST body contains unsupported properties");
  }
  if (body.extensions !== undefined && body.extensions !== null && !isRecord(body.extensions)) {
    return failure(400, "invalid-request", "GraphQL extensions must be a JSON object when supplied");
  }
  if (typeof body.query !== "string" || body.query.trim() === "") {
    return failure(400, "invalid-request", "The GraphQL POST body requires a query document");
  }
  if (body.operationName !== undefined && body.operationName !== null && typeof body.operationName !== "string") {
    return failure(400, "invalid-request", "GraphQL operationName must be a string when supplied");
  }
  if (body.variables !== undefined && !isRecord(body.variables)) {
    return failure(400, "invalid-variables", "GraphQL variables must be a JSON object");
  }

  const documentResult = await validateQueryDocument(
    schema,
    body.query,
    typeof body.operationName === "string" ? body.operationName : null,
  );
  if (!documentResult.ok) {
    return documentResult.kind === "operation"
      ? failure(400, "operation-not-query", documentResult.message)
      : failure(400, "invalid-document", documentResult.message);
  }

  if (input.documentLimits !== undefined) {
    // An introspection-only query never reaches a subgraph; tools such as GraphiQL send one deeper than a public query
    // may nest, so it meets limits shaped for introspection instead.
    const limits = isIntrospectionOnly(documentResult.value)
      ? introspectionLimitsFor(input.documentLimits)
      : input.documentLimits;
    const limitResult = checkDocumentLimits(documentResult.value, limits);
    if (!limitResult.ok) return failure(400, "query-too-complex", limitResult.message);
  }

  return finishNormalization(schema, documentResult.value, body.variables ?? {}, freshness);
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ async function finishNormalization(
  schema: GraphQLSchema,
  document: ValidatedDocument,
  rawVariables: unknown,
  freshness: CacheFreshnessPolicy,
): Promise<GatewayProtocolResult> {
  const variablesResult = validateVariables(schema, document, rawVariables);
  if (!variablesResult.ok) return failure(400, "invalid-variables", variablesResult.message);
  const operationIdentity = await operationResultIdentity(
    document.canonicalDocument,
    variablesResult.value.canonicalText,
  );

  const normalized: NormalizedGatewayRequest = {
    execution: {
      document: document.canonicalDocument,
      operationName: document.operationName,
      variables: variablesResult.value.value,
    },
    canonicalVariables: variablesResult.value.canonicalText,
    operationIdentity,
    syntheticGetKey: syntheticGetKey(operationIdentity),
    cachePolicy: selectGatewayCachePolicy(schema, document, variablesResult.value.value, freshness),
  };
  return { ok: true, value: normalized };
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const parts = value.split(";").map((part) => part.trim());
  const mediaType = parts.shift()?.toLowerCase();
  if (mediaType !== "application/json" || parts.some((part) => part === "")) return false;
  let sawCharset = false;
  for (const parameter of parts) {
    const match = /^charset=(?:"utf-8"|utf-8)$/iu.exec(parameter);
    if (match === null || sawCharset) return false;
    sawCharset = true;
  }
  return true;
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(
  status: GatewayProtocolError["status"],
  code: GatewayProtocolError["code"],
  message: string,
): GatewayProtocolResult {
  return { ok: false, error: { status, code, message } };
}
