import type { AgrisProxyExecutionProps } from "@agris/gateway-worker/gateway";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The operation a cache miss executes, carried from the gateway to its cache Worker.
 *
 * Deployed from its own entrypoint, the gateway hands it to the cached loopback entrypoint as `ctx.props`. A service
 * binding to another Worker carries no props, so the gateway sends it on the cache key request in this header instead;
 * only the gateway reaches the cache Worker, which has no public address. Workers Cache keys on the URL, not this
 * header.
 */
export const AGRIS_EXECUTION_HEADER = "x-agris-execution";

const ExecutionProps = Schema.Struct({
  cachePolicy: Schema.Union([
    Schema.Struct({ mode: Schema.Literal("no-store") }),
    Schema.Struct({
      mode: Schema.Literal("store"),
      maxAgeSeconds: Schema.Number,
      staleWhileRevalidateSeconds: Schema.Number,
      staleIfErrorSeconds: Schema.Number,
    }),
  ]),
  document: Schema.String,
  operationName: Schema.NullOr(Schema.String),
  variables: Schema.Record(Schema.String, Schema.Json),
  smokeFailureAfterEpochMs: Schema.NullOr(Schema.Number),
});

/** The header value: JSON in base64url, because a header carries only ASCII and the variables may not be. */
const ExecutionHeader = Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(ExecutionProps)));

const encodeExecutionHeader = Schema.encodeSync(ExecutionHeader);
const decodeExecutionHeader = Schema.decodeUnknownOption(ExecutionHeader);

/** The cache key request, carrying the operation it stands for. */
export function withExecutionProps(syntheticRequest: Request, props: AgrisProxyExecutionProps): Request {
  const request = new Request(syntheticRequest);
  request.headers.set(AGRIS_EXECUTION_HEADER, encodeExecutionHeader(props));
  return request;
}

/** The operation a cache key request carries, or `null` when it carries none the gateway could have sent. */
/* BOUNDARY: The header arrives over a service binding and is decoded with the schema before the gateway runs it. */
export function executionPropsOf(request: Request): AgrisProxyExecutionProps | null {
  const encoded = request.headers.get(AGRIS_EXECUTION_HEADER);
  return encoded === null ? null : Option.getOrNull(decodeExecutionHeader(encoded));
}
