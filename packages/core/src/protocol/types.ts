import type { GraphQLSchema } from "graphql";

import type { CacheFreshnessPolicy } from "./cache-freshness.js";
import type { GatewayDocumentLimits } from "./document-limits.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** One entry of a caller's approved-operation list, keyed by the SHA-256 hash of its canonical document. */
export interface PersistedOperationDefinition {
  readonly document: string;
}

export interface GatewayRequestProtocolInput {
  readonly schema: GraphQLSchema;
  /** Size limits a query must meet; the private Service Binding protocol takes none, its callers send approved documents. */
  readonly documentLimits?: GatewayDocumentLimits;
  /** The freshness windows the protocol chooses from; `DEFAULT_CACHE_FRESHNESS` when absent. */
  readonly cacheFreshness?: CacheFreshnessPolicy;
  /** Shorthand that replaces `cacheFreshness.minimumSeconds`; see `selectGatewayCachePolicy`. */
  readonly freshnessFloorSeconds?: number;
  /**
   * Accept, and ignore, the GraphQL-over-HTTP `extensions` object in a POST body, which clients such as GraphiQL send.
   * The private protocol leaves it off: its callers send exactly `query`, `operationName` and `variables`.
   */
  readonly acceptExtensions?: boolean;
}

export interface GatewayProtocolRequest {
  readonly method: string;
  readonly contentType: string | null;
  readonly searchParams: string;
  readonly bodyText: string | null;
}

export interface NormalizedExecutionInput {
  readonly document: string;
  readonly operationName: string | null;
  readonly variables: JsonObject;
}

export type GatewayCachePolicy =
  | { readonly mode: "no-store" }
  | {
      readonly mode: "store";
      readonly maxAgeSeconds: number;
      readonly staleWhileRevalidateSeconds: number;
      readonly staleIfErrorSeconds: number;
    };

export type GatewayCacheStatus = "HIT" | "MISS" | "EXPIRED" | "REVALIDATED" | "STALE" | "UPDATING" | "BYPASS";
export type GatewayResponseSource = "cache-fresh" | "cache-stale" | "live";
export type GatewayResponseRefresh = "not-attempted" | "in-background" | "succeeded" | "failed";

/**
 * What the execution's subgraph calls add up to. `answered`: at least one answered, so the response has data or field
 * errors. Otherwise `rate-limited` when a call was refused by a limiter, and `unavailable` when every call failed.
 */
export type GatewayUpstreamOutcome = "answered" | "rate-limited" | "unavailable";

export interface GatewayResponseClassificationInput {
  readonly cacheStatus: GatewayCacheStatus;
  readonly cachePolicy: GatewayCachePolicy;
  readonly hasGraphqlErrors: boolean;
  readonly upstream: GatewayUpstreamOutcome;
}

export interface GatewayResponseClassification {
  /** 200 when a subgraph answered, 429 when the calls were rate limited, 503 when they all failed. */
  readonly status: 200 | 429 | 503;
  readonly headers: {
    readonly "Cache-Control": string;
    readonly "X-Central-Market-Source": GatewayResponseSource;
    readonly "X-Central-Market-Refresh": GatewayResponseRefresh;
  };
}

export interface NormalizedGatewayRequest {
  readonly execution: NormalizedExecutionInput;
  readonly canonicalVariables: string;
  readonly operationIdentity: string;
  readonly syntheticGetKey: string;
  readonly cachePolicy: GatewayCachePolicy;
}

export type GatewayProtocolErrorCode =
  | "invalid-content-type"
  | "invalid-document"
  | "invalid-method"
  | "invalid-request"
  | "invalid-variables"
  | "operation-not-query"
  | "query-too-complex";

export interface GatewayProtocolError {
  readonly code: GatewayProtocolErrorCode;
  readonly message: string;
  readonly status: 400 | 405 | 415;
}

export type GatewayProtocolResult =
  | { readonly ok: true; readonly value: NormalizedGatewayRequest }
  | { readonly ok: false; readonly error: GatewayProtocolError };

export interface GatewayRequestProtocol {
  normalize(request: GatewayProtocolRequest): Promise<GatewayProtocolResult>;
}
