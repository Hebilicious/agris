/**
 * The browser side of the site's live examples: sends one query to the shared demo and sorts its answer into what the
 * result panel shows. The answer is `unknown` until it is checked: a GraphQL body is a JSON object, and its `errors`,
 * when present, is a list of objects that each carry a string `message`. Anything else is reported, never guessed at.
 *
 * Every visitor shares the demo's rate limit, so after a 429 this module holds every example back until the demo's
 * `Retry-After` has passed, instead of sending requests it already knows will be refused.
 */

/** What the response headers say about caching. */
export interface CacheReport {
  /** `Cf-Cache-Status`: Cloudflare's edge cache, such as HIT, MISS or STALE. The demo exposes it cross-origin. */
  readonly edge: string | null;
  /** `Age`: seconds since the cached answer was stored, when it came from the cache. */
  readonly age: number | null;
  /** `Cache-Control`: how long the gateway lets the answer be kept. A browser may always read it. */
  readonly control: string | null;
  /** `X-Central-Market-Source`: where the market subgraph's rows came from: live, cache-fresh or cache-stale. */
  readonly source: string | null;
}

interface Answered {
  readonly status: number;
  /** Round-trip time in milliseconds, from sending the request to reading the whole body. */
  readonly ms: number;
  readonly cache: CacheReport;
}

export type LiveResult =
  /** The query ran and the body has no errors. */
  | (Answered & { readonly kind: "data"; readonly body: unknown })
  /** A GraphQL body with errors, beside partial data or instead of it. */
  | (Answered & { readonly kind: "errors"; readonly messages: readonly string[]; readonly body: unknown })
  /** Rate limited: by the demo (a 429), or held back here because the demo refused an earlier request. */
  | { readonly kind: "busy"; readonly sent: boolean; readonly retryAfter: number; readonly ms: number | null }
  /** No GraphQL answer: the network failed, the request timed out, or the body was not a GraphQL response. */
  | { readonly kind: "failed"; readonly status: number | null; readonly ms: number; readonly message: string };

/** What one response was, before it is sorted. */
export interface Answer {
  readonly status: number;
  readonly header: (name: string) => string | null;
  readonly bodyText: string;
  readonly ms: number;
  /** Seconds to wait after a 429 that names no usable `Retry-After`: the demo's rate window. */
  readonly fallbackRetryAfter: number;
  /** The current time in epoch milliseconds, for a `Retry-After` given as a date. */
  readonly now: number;
}

/** Sorts one response into what the panel shows. Pure: the network and the clock come in through `answer`. */
export function classify(answer: Answer): LiveResult {
  const { status, header, bodyText, ms } = answer;
  if (status === 429) {
    return { kind: "busy", sent: true, ms, retryAfter: retryAfterOf(header("Retry-After"), answer) };
  }
  const body = parseJson(bodyText);
  const shape = body.ok ? graphqlShapeOf(body.value) : null;
  if (shape === null) {
    const what = bodyText.trim() === "" ? "an empty body" : "a body that is not a GraphQL response";
    return { kind: "failed", status, ms, message: `The demo answered ${status} with ${what}.` };
  }
  const cache = cacheReportOf(header);
  if (shape.messages.length > 0)
    return { kind: "errors", status, ms, cache, messages: shape.messages, body: shape.body };
  if (status < 200 || status > 299) {
    return { kind: "failed", status, ms, message: `The demo answered ${status} without saying why.` };
  }
  return { kind: "data", status, ms, cache, body: shape.body };
}

/** `Retry-After` is whole seconds or an HTTP date; anything else falls back to the demo's rate window. */
export function retryAfterOf(
  value: string | null,
  { fallbackRetryAfter, now }: Pick<Answer, "fallbackRetryAfter" | "now">,
): number {
  const text = value?.trim() ?? "";
  if (/^\d+$/.test(text)) return Math.max(1, Number(text));
  const date = Date.parse(text);
  if (Number.isFinite(date)) return Math.max(1, Math.ceil((date - now) / 1000));
  return fallbackRetryAfter;
}

export function cacheReportOf(header: (name: string) => string | null): CacheReport {
  const age = header("Age")?.trim() ?? "";
  return {
    edge: header("Cf-Cache-Status")?.trim().toUpperCase() || null,
    age: /^\d+$/.test(age) ? Number(age) : null,
    control: header("Cache-Control")?.trim() || null,
    source: header("X-Central-Market-Source")?.trim() || null,
  };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/* BOUNDARY: a response body from another origin. A GraphQL response is an object with `data`, `errors` or both. */
function graphqlShapeOf(value: unknown): { body: unknown; messages: string[] } | null {
  if (!isRecord(value) || !("data" in value || "errors" in value)) return null;
  const { errors } = value;
  if (errors === undefined) return { body: value, messages: [] };
  if (!Array.isArray(errors)) return null;
  const messages: string[] = [];
  for (const error of errors) {
    if (!isRecord(error) || typeof error.message !== "string") return null;
    messages.push(error.message);
  }
  return { body: value, messages };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** When the demo will take requests again, in epoch milliseconds; shared by every example on the page. */
let busyUntil = 0;

/** Whole seconds until the demo will take requests again, `0` when it will now. */
export function cooldownLeft(now = Date.now()): number {
  return Math.max(0, Math.ceil((busyUntil - now) / 1000));
}

export interface RunOptions {
  readonly endpoint: string;
  readonly query: string;
  /** Aborts the request when the reader closes the panel. */
  readonly signal: AbortSignal;
  readonly fallbackRetryAfter: number;
  /** A guard on a request that never settles; the gateway's own upstream timeout is shorter. */
  readonly timeoutMs: number;
}

/** Sends `query` to the demo and sorts the answer. Never throws: every outcome is a `LiveResult`. */
export async function runQuery({
  endpoint,
  query,
  signal,
  fallbackRetryAfter,
  timeoutMs,
}: RunOptions): Promise<LiveResult> {
  const held = cooldownLeft();
  if (held > 0) return { kind: "busy", sent: false, retryAfter: held, ms: null };
  const started = performance.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/graphql-response+json, application/json" },
      body: JSON.stringify({ query }),
      credentials: "omit",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    const bodyText = await response.text();
    const now = Date.now();
    const result = classify({
      status: response.status,
      header: (name) => response.headers.get(name),
      bodyText,
      ms: performance.now() - started,
      fallbackRetryAfter,
      now,
    });
    if (result.kind === "busy") busyUntil = Math.max(busyUntil, now + result.retryAfter * 1000);
    return result;
  } catch (error) {
    const ms = performance.now() - started;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    const message = timedOut
      ? `The demo did not answer within ${Math.round(timeoutMs / 1000)} s.`
      : "The request did not reach the demo. Check your connection, then try again.";
    return { kind: "failed", status: null, ms, message };
  }
}
