/**
 * The exact market admission: one token bucket per client, stored by a `GatewayAdmission` Durable Object, which an
 * execution asks once before its first market subgraph call.
 *
 * Cloudflare's rate-limit bindings count per location and converge after the fact, so a parallel burst, or a client
 * whose requests land on several locations, outruns them. A Durable Object is one instance worldwide that handles its
 * requests one at a time, so its bucket admits exactly what its rate allows, however the requests arrive. It costs a
 * round trip and a storage write, so only work that would reach Pearl Abyss pays it: a cache hit, a catalog-only query,
 * a health check or a preflight never asks.
 *
 * This module imports nothing, so Node loads it by its subpath (`@agris/gateway-worker/admission`) without a TypeScript
 * loader, and the deploy settings read the variable names from here.
 */

/** The runtime variables of the exact market admission. Absent or `0` requests sets none. */
export const MARKET_ADMISSION_SETTING = Object.freeze({
  requests: "MARKET_CLIENT_LIMIT_REQUESTS",
  period: "MARKET_CLIENT_LIMIT_PERIOD_SECONDS",
});

/** The period of the exact market admission when `MARKET_CLIENT_LIMIT_PERIOD_SECONDS` is unset. */
export const DEFAULT_MARKET_ADMISSION_PERIOD_SECONDS = 60;

/** How long a caller refused because admission could not answer should wait before trying again. */
export const ADMISSION_UNAVAILABLE_RETRY_SECONDS = 5;

/**
 * The header that carries a public caller's client key from the public gateway to the execution that may call the
 * market. It rides on the cache key request, never in `ctx.props`, because Workers Cache keys on an invocation's props
 * and ignores headers like this one: the stored answers stay shared by every client. Only the public gateway builds that
 * request, so a caller cannot set it.
 */
export const CLIENT_ADMISSION_KEY_HEADER = "x-agris-admission-client";

const MARKET_ADMISSION_PREFIX = "MARKET_CLIENT_LIMIT_";
const KNOWN_MARKET_ADMISSION_SETTINGS: ReadonlySet<string> = new Set(Object.values(MARKET_ADMISSION_SETTING));
const ADMISSION_URL = "https://gateway-admission.internal/admit";

/** An exact limit: at most `limit` requests in any `periodSeconds`, refilling evenly, with a burst of `limit`. */
export interface AdmissionRate {
  readonly limit: number;
  readonly periodSeconds: number;
}

/** One bucket's answer: admitted, or refused until a token is back in `retryAfterSeconds`. */
export type AdmissionDecision =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly retryAfterSeconds: number };

/** The `GatewayAdmission` namespace, as far as the gateway uses it. A Workers `DurableObjectNamespace` is one. */
export interface AdmissionNamespacePort {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
}

/** What an execution needs to admit its market calls: the namespace that keeps the buckets and the rate they hold. */
export interface MarketAdmission {
  readonly namespace: AdmissionNamespacePort;
  readonly rate: AdmissionRate;
}

/**
 * BOUNDARY: A deployment's exact market admission rate, from its `MARKET_CLIENT_LIMIT_*` variables, or `null` when it
 * sets none. The count and the period are whole numbers as text or JSON numbers; a count of `0` turns it off. Anything
 * else, and any `MARKET_CLIENT_LIMIT_` variable that is no setting, throws, so a bad configuration fails instead of
 * admitting everyone.
 */
export function marketAdmissionRateFromBindings(bindings: object): AdmissionRate | null {
  for (const name of Object.keys(bindings)) {
    if (name.startsWith(MARKET_ADMISSION_PREFIX) && !KNOWN_MARKET_ADMISSION_SETTINGS.has(name)) {
      throw new TypeError(`${name} is not a market admission setting`);
    }
  }
  const values = new Map<string, unknown>(Object.entries(bindings));
  const limit = wholeNumber(values.get(MARKET_ADMISSION_SETTING.requests), MARKET_ADMISSION_SETTING.requests);
  const periodSeconds = wholeNumber(values.get(MARKET_ADMISSION_SETTING.period), MARKET_ADMISSION_SETTING.period);
  if (periodSeconds === 0) {
    throw new TypeError(`${MARKET_ADMISSION_SETTING.period} must be a positive whole number of seconds`);
  }
  if (limit === undefined || limit === 0) return null;
  return { limit, periodSeconds: periodSeconds ?? DEFAULT_MARKET_ADMISSION_PERIOD_SECONDS };
}

/**
 * The market admission an execution runs with: the deployment's rate and the namespace that keeps its buckets, or
 * `undefined` when the deployment sets no rate. A rate without a namespace throws, so a deployment that asked for an
 * exact limit never runs without one.
 */
export function marketAdmissionFromBindings(
  bindings: object,
  namespace: AdmissionNamespacePort | undefined,
): MarketAdmission | undefined {
  const rate = marketAdmissionRateFromBindings(bindings);
  if (rate === null) return undefined;
  if (namespace === undefined) {
    throw new TypeError(
      `${MARKET_ADMISSION_SETTING.requests} is set, but the Worker binds no ADMISSION Durable Object namespace`,
    );
  }
  return { namespace, rate };
}

/* BOUNDARY: One `MARKET_CLIENT_LIMIT_*` binding: absent, or a whole number as text or a JSON number. */
function wholeNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const number = typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${name} must be a whole number`);
  }
  return number;
}

/**
 * The key a client is admitted under: its IPv4 address, or the /64 network of its IPv6 address, because one IPv6
 * subscriber is commonly given a whole /64 and could otherwise take a fresh allowance with every address in it. A
 * request without `CF-Connecting-IP`, which Cloudflare always sets, shares one key with every other such request.
 */
export function clientAdmissionKey(address: string | null): string {
  if (address === null || address === "") return "unknown-client";
  if (!address.includes(":")) return address;
  const network = ipv6Network(address.toLowerCase());
  return network === undefined ? address : `${network}::/64`;
}

/** The first four groups of an IPv6 address, each without leading zeros, or `undefined` when it is not one. */
function ipv6Network(address: string): string | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const groupsOf = (half: string | undefined) => (half === undefined || half === "" ? [] : half.split(":"));
  const head = groupsOf(halves[0]);
  const tail = groupsOf(halves[1]);
  // A trailing dotted IPv4 part stands for the last two groups.
  const tailLength = tail.length + (tail.at(-1)?.includes(".") === true ? 1 : 0);
  const missing = 8 - head.length - tailLength;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
  const network = groups.slice(0, 4);
  if (!network.every((group) => /^[0-9a-f]{1,4}$/u.test(group))) return undefined;
  return network.map((group) => group.replace(/^0+(?=.)/u, "")).join(":");
}

/** The cache key request with the client key the execution behind it admits its market calls under. */
export function withClientAdmissionKey(request: Request, clientKey: string | null): Request {
  if (clientKey === null) return request;
  const keyed = new Request(request);
  keyed.headers.set(CLIENT_ADMISSION_KEY_HEADER, clientKey);
  return keyed;
}

/** The client key a cache key request carries, or `null` when a private caller sent it. */
export function clientAdmissionKeyOf(request: Request): string | null {
  const key = request.headers.get(CLIENT_ADMISSION_KEY_HEADER);
  return key === null || key === "" ? null : key;
}

/** The name of the `GatewayAdmission` object that keeps one client's bucket. */
export function admissionObjectName(clientKey: string): string {
  return `client:${clientKey}`;
}

/** Ask one `GatewayAdmission` object to admit a request at `rate`. Any failure, or an unexpected answer, throws. */
export async function admitThrough(
  namespace: AdmissionNamespacePort,
  name: string,
  rate: AdmissionRate,
): Promise<AdmissionDecision> {
  const response = await namespace.getByName(name).fetch(
    new Request(ADMISSION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rate),
    }),
  );
  if (!response.ok) throw new Error(`GatewayAdmission answered ${response.status}`);
  return admissionDecisionOf(await response.json());
}

/* BOUNDARY: A `GatewayAdmission` object's answer, checked to be a decision. */
function admissionDecisionOf(body: unknown): AdmissionDecision {
  if (typeof body === "object" && body !== null && "admitted" in body) {
    if (body.admitted === true) return { admitted: true };
    if (body.admitted === false && "retryAfterSeconds" in body) {
      const seconds = body.retryAfterSeconds;
      if (typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 1) {
        return { admitted: false, retryAfterSeconds: seconds };
      }
    }
  }
  throw new TypeError("GatewayAdmission answered with no admission decision");
}

/*
 * BOUNDARY: The bucket an object stored, or `undefined` when it has stored none. Anything else throws, so the execution
 * refuses the request as it does when an object cannot answer, rather than guessing at a full bucket.
 */
function admissionBucketStateOf(value: unknown): AdmissionBucketState | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "object" && value !== null) {
    const fields = ["limit", "periodSeconds", "tokens", "updatedAtMs"].map((name) =>
      name in value ? Reflect.get(value, name) : undefined,
    );
    const [limit, periodSeconds, tokens, updatedAtMs] = fields;
    const finite = (number: unknown): number is number => typeof number === "number" && Number.isFinite(number);
    if (finite(limit) && finite(periodSeconds) && finite(tokens) && finite(updatedAtMs) && tokens >= 0) {
      return { limit, periodSeconds, tokens, updatedAtMs };
    }
  }
  throw new TypeError("A GatewayAdmission object stored no readable bucket");
}

/* BOUNDARY: The rate an execution sent to its `GatewayAdmission` object, checked before the bucket uses it. */
function admissionRateOf(body: unknown): AdmissionRate | undefined {
  if (typeof body !== "object" || body === null || !("limit" in body) || !("periodSeconds" in body)) return undefined;
  const { limit, periodSeconds } = body;
  const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
  return positive(limit) && positive(periodSeconds) ? { limit, periodSeconds } : undefined;
}

/** What a bucket stores after every decision: the rate it last counted at, its tokens, and when it counted them. */
export interface AdmissionBucketState {
  readonly limit: number;
  readonly periodSeconds: number;
  readonly tokens: number;
  readonly updatedAtMs: number;
}

/**
 * Where a `GatewayAdmission` object keeps its bucket: the synchronous key-value API of its SQLite-backed storage
 * (`ctx.storage.kv`), which a Workers `SyncKvStorage` is.
 */
export interface AdmissionStore {
  get(key: string): unknown;
  put(key: string, value: AdmissionBucketState): void;
}

const BUCKET_KEY = "bucket";

/**
 * One client's token bucket, which a `GatewayAdmission` object keeps in its own storage. It holds up to `limit` tokens,
 * refills `limit` of them evenly over `periodSeconds`, and spends one per admitted request.
 *
 * Every decision reads the stored bucket and writes it back before answering, so an object the runtime evicts while it
 * is idle, or restarts with a deploy, carries on from the tokens it had instead of from a full bucket. The read and the
 * write are synchronous, so no other request runs between them, and the object's output gate holds the answer until
 * the write is durable.
 */
export class AdmissionBucket {
  private readonly store: AdmissionStore;

  public constructor(store: AdmissionStore) {
    this.store = store;
  }

  public admit(rate: AdmissionRate, nowMs: number): AdmissionDecision {
    // A first request starts from a full bucket. A deployment that changed its rate keeps the tokens it had, up to the
    // new limit, so a new rate never hands a client that spent its allowance a fresh one.
    const previous = admissionBucketStateOf(this.store.get(BUCKET_KEY)) ?? { tokens: rate.limit, updatedAtMs: nowMs };
    const periodMs = rate.periodSeconds * 1000;
    const elapsedMs = Math.max(0, nowMs - previous.updatedAtMs);
    const tokens = Math.min(rate.limit, previous.tokens + (elapsedMs * rate.limit) / periodMs);
    const admitted = tokens >= 1;
    const remaining = admitted ? tokens - 1 : tokens;
    this.store.put(BUCKET_KEY, { ...rate, tokens: remaining, updatedAtMs: Math.max(nowMs, previous.updatedAtMs) });
    if (admitted) return { admitted: true };
    const untilNextTokenMs = ((1 - remaining) * periodMs) / rate.limit;
    return { admitted: false, retryAfterSeconds: Math.max(1, Math.ceil(untilNextTokenMs / 1000)) };
  }

  /** Answer one admission request an execution sent with `admitThrough`. */
  public async answer(request: Request, nowMs: number): Promise<Response> {
    const rate = admissionRateOf(await request.json().catch(() => undefined));
    const headers = { "Cache-Control": "no-store" };
    if (rate === undefined)
      return Response.json({ error: "An admission request carries a rate" }, { status: 400, headers });
    return Response.json(this.admit(rate, nowMs), { headers });
  }
}
