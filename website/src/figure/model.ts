/**
 * The pure model behind Fig 1, "The Agris exchange". Every number the figure shows, and every part it moves, comes
 * from these functions. Nothing here touches the DOM, so the page and a Node test read the same rules.
 *
 * It is an illustration, not the gateway: it mirrors the gateway's cache policy, its per-visitor limit and Cloudflare's
 * edge cache closely enough to explain them (a fixed one-minute window where the gateway refills a token bucket, fresh
 * and stale-while-revalidate windows), with
 * the windows and limits read from the gateway's own policy and `src/deployment.ts`.
 *
 * Time is simulated seconds. The page advances it by real seconds times the figure's speed, so a 60 second window can
 * drain while a reader watches.
 *
 * This module runs in the browser, so it imports nothing from the gateway: the limits it enforces arrive as a
 * `MachineFacts` value the build reads from `src/facts.ts` and writes into the page.
 */

/** The query cards the figure can send. Each one is a real query from the "Try a query" section. */
export type QueryKind = "prices" | "orderBook" | "hot" | "names" | "search";

export const QUERY_KINDS: readonly QueryKind[] = ["prices", "orderBook", "hot", "names", "search"];

/** How long a stored answer may be served, as the gateway's cache policy chose it for this query. */
export type CachePolicy =
  | {
      readonly mode: "store";
      readonly maxAge: number;
      readonly staleWhileRevalidate: number;
      readonly staleIfError: number;
    }
  | { readonly mode: "no-store" };

/** One card the figure can send: its query, the policy the real gateway code chose for it, and what it costs. */
export interface FigureQuery {
  readonly kind: QueryKind;
  /** The button text. */
  readonly label: string;
  readonly policy: CachePolicy;
  /** The first characters of the real cache key (SHA-256 of the policy version, canonical document and variables). */
  readonly key: string;
  /** Calls to Pearl Abyss one miss makes: a summary batch for `Market.items`, one more per item for each detail field. */
  readonly upstreamCalls: number;
  /** Which subgraphs the federation plan reaches. */
  readonly catalog: boolean;
  readonly market: boolean;
  /** The locale of the names the catalog looks up, which picks the drawer that opens. */
  readonly locale: Locale;
}

/** The catalog's 12 locales, in the order of the drawers in the cabinet. */
export const LOCALES = ["EN", "DE", "FR", "ES", "ES_EU", "PT", "RU", "TR", "JA", "KO", "TH", "ZH_TW"] as const;
export type Locale = (typeof LOCALES)[number];

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

/** A fixed-window rate limit: `limit` requests per `period` seconds. */
export interface RateLimit {
  readonly limit: number;
  readonly period: number;
}

/** The deployment the machine is drawn for: a self-hosted gateway's limits, read by the build from `src/facts.ts`. */
export interface MachineFacts {
  /** The gateway's client limiter, which the turnstile enforces. */
  readonly rate: RateLimit;
  /** Distinct Pearl Abyss requests one coordinator runs at once: the carousel's cradles. */
  readonly carriages: number;
}

export interface StoredAnswer {
  /** Simulated second the answer was filed. */
  readonly storedAt: number;
}

export interface ExchangeState {
  /** The current fixed rate-limit window: when it opened and how many requests it admitted. */
  readonly window: { readonly openedAt: number; readonly used: number };
  /** One pigeonhole per storable query. */
  readonly answers: Readonly<Partial<Record<QueryKind, StoredAnswer>>>;
}

export const INITIAL_STATE: ExchangeState = { window: { openedAt: 0, used: 0 }, answers: {} };

/** What happened to one card. */
export type Outcome =
  | { readonly kind: "rejected"; readonly retryAfter: number }
  | { readonly kind: "hit"; readonly age: number }
  | { readonly kind: "stale"; readonly age: number }
  | { readonly kind: "miss"; readonly stored: boolean };

/** Where an answer's hourglass stands: both bulbs as shares of their window still to run. */
export interface Hourglass {
  readonly phase: "empty" | "fresh" | "stale" | "expired";
  /** Upper bulb: the fresh window still to run, 1 when just filed. */
  readonly fresh: number;
  /** Lower bulb: the stale-while-revalidate window still to run; full until the fresh window ends. */
  readonly stale: number;
  readonly age: number;
}

/** The rate-limit window as it stands at `now`: a new window opens once the period has passed. */
export function windowAt(state: ExchangeState, now: number, rate: RateLimit): ExchangeState["window"] {
  return now - state.window.openedAt >= rate.period ? { openedAt: now, used: 0 } : state.window;
}

/** How many more requests the current window admits. */
export function allowanceAt(state: ExchangeState, now: number, rate: RateLimit): number {
  return rate.limit - windowAt(state, now, rate).used;
}

/** Spend every request the window has left, as a client sending in a tight loop would. */
export function exhaust(state: ExchangeState, now: number, rate: RateLimit): ExchangeState {
  const window = windowAt(state, now, rate);
  return { ...state, window: { openedAt: window.openedAt, used: rate.limit } };
}

export function hourglassOf(state: ExchangeState, query: FigureQuery, now: number): Hourglass {
  const answer = state.answers[query.kind];
  if (answer === undefined || query.policy.mode === "no-store") return { phase: "empty", fresh: 0, stale: 0, age: 0 };
  const { maxAge, staleWhileRevalidate } = query.policy;
  const age = Math.max(0, now - answer.storedAt);
  const fresh = clamp01(1 - age / maxAge);
  const stale = age <= maxAge ? 1 : clamp01(1 - (age - maxAge) / staleWhileRevalidate);
  const phase = age < maxAge ? "fresh" : age < maxAge + staleWhileRevalidate ? "stale" : "expired";
  return { phase, fresh, stale, age };
}

/**
 * Send one card at `now`. The limiter runs first (a rejected card never reaches the cache), then the pigeonhole for
 * the card's key answers fresh or stale, and only a miss travels on. A stale answer is served at once; the background
 * refresh files a new one when it returns, which the page does with `file`.
 */
export function send(
  state: ExchangeState,
  query: FigureQuery,
  now: number,
  rate: RateLimit,
): { state: ExchangeState; outcome: Outcome } {
  const window = windowAt(state, now, rate);
  if (window.used >= rate.limit) {
    const retryAfter = rate.period;
    return { state: { ...state, window }, outcome: { kind: "rejected", retryAfter } };
  }
  const admitted: ExchangeState = { ...state, window: { openedAt: window.openedAt, used: window.used + 1 } };
  const glass = hourglassOf(admitted, query, now);
  if (glass.phase === "fresh") return { state: admitted, outcome: { kind: "hit", age: glass.age } };
  if (glass.phase === "stale") return { state: admitted, outcome: { kind: "stale", age: glass.age } };
  return { state: admitted, outcome: { kind: "miss", stored: query.policy.mode === "store" } };
}

/** File a fresh answer in the card's pigeonhole, if its policy lets it be stored. */
export function file(state: ExchangeState, query: FigureQuery, now: number): ExchangeState {
  if (query.policy.mode === "no-store") return state;
  return { ...state, answers: { ...state.answers, [query.kind]: { storedAt: now } } };
}

/** A window in the shortest exact unit: `5 s`, `70 s`, `1 h`, `1 day`, `1 year`. */
export function durationOf(seconds: number): string {
  if (seconds >= 31_536_000 && seconds % 31_536_000 === 0) return plural(seconds / 31_536_000, "year");
  if (seconds >= 86_400 && seconds % 86_400 === 0) return plural(seconds / 86_400, "day");
  if (seconds >= 3_600 && seconds % 3_600 === 0) return `${seconds / 3_600} h`;
  if (seconds >= 60 && seconds % 60 === 0 && seconds > 90) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** An age as the readout prints it: whole seconds, then minutes. */
export function ageOf(seconds: number): string {
  const whole = Math.floor(seconds);
  if (whole < 120) return `${whole} s`;
  if (whole < 7_200) return `${Math.floor(whole / 60)} min`;
  return `${Math.floor(whole / 3_600)} h`;
}

/** The short card label for a policy: `fresh 60 s`, or `never stored`. */
export function windowOf(policy: CachePolicy): string {
  return policy.mode === "no-store" ? "never stored" : `fresh ${durationOf(policy.maxAge)}`;
}

/** The readout for one outcome, in the words and numbers the response headers carry. */
export function readoutOf(outcome: Outcome, query: FigureQuery): string {
  const calls = (count: number) => `${count} upstream ${count === 1 ? "call" : "calls"}`;
  switch (outcome.kind) {
    case "rejected":
      return `429 · retry after ${outcome.retryAfter} s · ${calls(0)}`;
    case "hit":
      return `HIT · age ${ageOf(outcome.age)} · ${calls(0)}`;
    case "stale":
      return `STALE · age ${ageOf(outcome.age)} · refreshing`;
    case "miss":
      return outcome.stored
        ? `MISS · ${calls(query.upstreamCalls)} · ${windowOf(query.policy)}`
        : `BYPASS · ${calls(query.upstreamCalls)} · never stored`;
  }
}

/** `1st`, `22nd`, `61st`, `113th`. */
export function ordinalOf(count: number): string {
  const tens = count % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][count % 10] ?? "th");
  return `${count}${suffix}`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
