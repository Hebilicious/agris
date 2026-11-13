import type { GraphQLSchema } from "graphql";

import { applyCacheFreshnessOverride, DEFAULT_CACHE_FRESHNESS, type CacheFreshnessPolicy } from "./cache-freshness.js";
import { selectGatewayCachePolicy } from "./cache-policy.js";
import { operationResultIdentity, syntheticGetKey } from "./identity.js";
export { dispatchGatewayOperation, type GatewayOperationDispatchPort } from "./operation-result.js";
import {
  validateQueryDocument,
  validateVariables,
  type DocumentValidationFailureKind,
  type ValidatedDocument,
} from "./document.js";
import { protocolFailure } from "./protocol-error.js";
import {
  checkDocumentLimits,
  introspectionLimitsFor,
  isIntrospectionOnly,
  PUBLIC_DOCUMENT_LIMITS,
  type GatewayDocumentLimits,
} from "./document-limits.js";
import type {
  GatewayProtocolErrorCode,
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
export { GATEWAY_PROTOCOL_ERROR_STATUS, protocolFailure } from "./protocol-error.js";
export {
  GRAPHQL_RESPONSE_MEDIA_TYPE,
  LEGACY_JSON_MEDIA_TYPE,
  negotiateGraphqlResponseMediaType,
  type GraphqlResponseMediaType,
} from "./media-type.js";
export {
  isPersistedOperationId,
  parseCanonicalPersistedGet,
  type CanonicalPersistedGet,
  type CanonicalPersistedGetResult,
} from "./persisted-get.js";
export type {
  GatewayProtocolError,
  GatewayProtocolErrorCode,
  GatewayProtocolErrorStatus,
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
  GatewayUpstreamOutcome,
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
        : Promise.resolve(protocolFailure("invalid-method", "Only GraphQL POST requests are accepted")),
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
 * The public gateway's request protocol: the private protocol plus the public document limits, and a POST body read as
 * GraphQL over HTTP asks, which accepts `extensions` and ignores properties it does not understand. Every public caller, and the website that
 * checks its example queries, builds it here so they cannot disagree about what a public query may be.
 */
export function createPublicGatewayRequestProtocol(input: PublicGatewayRequestProtocolInput): GatewayRequestProtocol {
  return createGatewayRequestProtocol({
    schema: input.schema,
    documentLimits: input.documentLimits ?? PUBLIC_DOCUMENT_LIMITS,
    graphqlOverHttpBody: true,
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

/** The POST body keys the private protocol reads; it refuses any other, while the public protocol ignores them. */
const PRIVATE_BODY_KEYS: ReadonlySet<string> = new Set(["query", "operationName", "variables"]);

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ async function normalizePost(
  input: GatewayRequestProtocolInput,
  freshness: CacheFreshnessPolicy,
  request: GatewayProtocolRequest,
): Promise<GatewayProtocolResult> {
  const { schema } = input;
  if (!isJsonContentType(request.contentType)) {
    return protocolFailure("invalid-content-type", "GraphQL POST requests require application/json with UTF-8 charset");
  }
  if (request.searchParams !== "") {
    return protocolFailure("invalid-request", "GraphQL POST requests cannot include query parameters");
  }
  if (request.bodyText === null || request.bodyText.trim() === "") {
    return protocolFailure("malformed-json", "GraphQL POST requests require one JSON request object");
  }

  let body: unknown;
  try {
    body = JSON.parse(request.bodyText);
  } catch {
    return protocolFailure("malformed-json", "The GraphQL POST body is malformed JSON");
  }
  if (!isRecord(body)) {
    return protocolFailure("invalid-request", "The GraphQL POST body must be one request object");
  }
  if (input.graphqlOverHttpBody === true) {
    if (body.extensions !== undefined && body.extensions !== null && !isRecord(body.extensions)) {
      return protocolFailure("invalid-request", "GraphQL extensions must be a JSON object when supplied");
    }
  } else if (Object.keys(body).some((key) => !PRIVATE_BODY_KEYS.has(key))) {
    return protocolFailure("invalid-request", "The GraphQL POST body contains unsupported properties");
  }
  if (typeof body.query !== "string" || body.query.trim() === "") {
    return protocolFailure("invalid-request", "The GraphQL POST body requires a query document");
  }
  if (body.operationName !== undefined && body.operationName !== null && typeof body.operationName !== "string") {
    return protocolFailure("invalid-request", "GraphQL operationName must be a string when supplied");
  }
  // GraphQL over HTTP reads a null optional parameter as an absent one.
  const variables = body.variables ?? {};
  if (!isRecord(variables)) {
    return protocolFailure("invalid-variables", "GraphQL variables must be a JSON object");
  }

  const documentResult = await validateQueryDocument(
    schema,
    body.query,
    typeof body.operationName === "string" ? body.operationName : null,
  );
  if (!documentResult.ok) {
    return protocolFailure(DOCUMENT_FAILURE_CODES[documentResult.kind], documentResult.message);
  }

  if (input.documentLimits !== undefined) {
    // An introspection-only query never reaches a subgraph; tools such as GraphiQL send one deeper than a public query
    // may nest, so it meets limits shaped for introspection instead.
    const limits = isIntrospectionOnly(documentResult.value)
      ? introspectionLimitsFor(input.documentLimits)
      : input.documentLimits;
    const limitResult = checkDocumentLimits(documentResult.value, limits);
    if (!limitResult.ok) return protocolFailure("query-too-complex", limitResult.message);
  }

  return finishNormalization(schema, documentResult.value, variables, freshness);
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ async function finishNormalization(
  schema: GraphQLSchema,
  document: ValidatedDocument,
  rawVariables: unknown,
  freshness: CacheFreshnessPolicy,
): Promise<GatewayProtocolResult> {
  const variablesResult = validateVariables(schema, document, rawVariables);
  if (!variablesResult.ok) return protocolFailure("invalid-variables", variablesResult.message);
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

const DOCUMENT_FAILURE_CODES = {
  malformed: "malformed-document",
  document: "invalid-document",
  operation: "operation-not-query",
} as const satisfies Record<DocumentValidationFailureKind, GatewayProtocolErrorCode>;
