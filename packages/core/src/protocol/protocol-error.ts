import type { GatewayProtocolErrorCode, GatewayProtocolErrorStatus, GatewayProtocolResult } from "./types.js";

/**
 * The status GraphQL over HTTP gives each request error (section 5.4): `400` for JSON or a document that cannot be
 * parsed, `422` for a request that is not well formed or a query that fails validation, and `405`, `413`, `414` and
 * `415` for the method, the size and the media type.
 */
export const GATEWAY_PROTOCOL_ERROR_STATUS = {
  "body-too-large": 413,
  "invalid-content-type": 415,
  "invalid-document": 422,
  "invalid-method": 405,
  "invalid-request": 422,
  "invalid-variables": 422,
  "malformed-document": 400,
  "malformed-json": 400,
  "operation-not-query": 422,
  "query-too-complex": 422,
  "url-too-long": 414,
} as const satisfies Record<GatewayProtocolErrorCode, GatewayProtocolErrorStatus>;

/** A refused request, with the status its code carries. */
export function protocolFailure(
  code: GatewayProtocolErrorCode,
  message: string,
): Extract<GatewayProtocolResult, { readonly ok: false }> {
  return { ok: false, error: { status: GATEWAY_PROTOCOL_ERROR_STATUS[code], code, message } };
}
