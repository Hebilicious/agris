import {
  BoundedConnectionPool,
  InvocationBudget,
  invocationBudgetReservation,
  MarketSummaryBudgetExceededError,
  type ConnectionLease,
  type InvocationBudgetReservation,
  type MarketSummaryReservation,
} from "@agris/invocation-budget";
import { createActor, createAsyncLogic, setup, toPromise, types } from "xstate";

import { pearlAbyssCategoriesFor } from "../protocol/categories.js";
import { decodePearlAbyssPayload, decodePearlAbyssResponseBody } from "../protocol/codecs.js";
import {
  type PearlAbyssCapabilityResponse,
  type PearlAbyssHotItem,
  type PearlAbyssRequest,
  type PearlAbyssRequestInput,
} from "../protocol/models.js";
import { buildPearlAbyssRequest } from "../protocol/requests.js";

export { MarketSummaryBudgetExceededError } from "@agris/invocation-budget";

const PEARL_ABYSS_RATE_LIMIT_KEY = "central-market-pearl-abyss";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAXIMUM_OUTBOUND_CONNECTIONS = 6;
export const MAXIMUM_PEARL_ABYSS_RESPONSE_BYTES = 1_024 * 1_024;

/**
 * How long a caller should wait after Pearl Abyss work was throttled, in seconds: the longest window a Workers rate
 * limit counts over, so the market's limiter has always started a fresh window by then.
 */
export const PEARL_ABYSS_THROTTLE_RETRY_AFTER_SECONDS = 60;

export type PearlAbyssUpstreamErrorCode =
  | "upstream/budget-exceeded"
  | "upstream/invalid-response"
  | "upstream/queue-full"
  | "upstream/rate-limited"
  | "upstream/timeout"
  | "upstream/unavailable";

export class PearlAbyssUpstreamError extends Error {
  public constructor(
    public readonly code: PearlAbyssUpstreamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PearlAbyssUpstreamError";
  }
}

export interface PearlAbyssHttpResponse {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly contentLength: string | null;
  readonly status: number;
}

export interface PearlAbyssHttpPort {
  fetch(request: PearlAbyssRequest, signal: AbortSignal): Promise<PearlAbyssHttpResponse>;
}

export interface PearlAbyssLimiterPort {
  limit(key: string): Promise<{ readonly success: boolean }>;
}

export interface PearlAbyssTimeoutPort {
  run<Value>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<Value>,
  ): Promise<
    { readonly timedOut: false; readonly value: Value } | { readonly timedOut: true; readonly settled: Promise<void> }
  >;
}

export interface PearlAbyssMarketReaderInput {
  readonly budget?: InvocationBudget;
  readonly reserveBudget?: InvocationBudgetReservation;
  readonly reserveMarketSummary?: MarketSummaryReservation;
  readonly http: PearlAbyssHttpPort;
  readonly limiter: PearlAbyssLimiterPort;
  readonly onRequestSettled?: (outcome: PearlAbyssRequestSettlement) => void;
  readonly timeout: PearlAbyssTimeoutPort;
  readonly timeoutMs?: number;
}

/**
 * How one distinct Pearl Abyss read ended: it `succeeded`; it `failed` to arrive (unreachable, an unsuccessful status,
 * a timeout or an unreadable answer); it was `rate-limited` by a limiter in front of Pearl Abyss or a full coordinator
 * queue; or it was `refused` by the invocation budget before anything was sent. Only `failed` says anything about Pearl Abyss itself.
 */
export type PearlAbyssRequestSettlement = "succeeded" | "failed" | "rate-limited" | "refused";

export interface NormalizedMarketSummary {
  readonly itemId: number;
  readonly basePrice: number | null;
  readonly currentStock: number | null;
  readonly totalTrades: number | null;
}

export interface NormalizedMarketCategory {
  readonly main: number;
  readonly sub: number | null;
}

export interface NormalizedMarketListing {
  readonly minimumEnhancementLevel: number;
  readonly maximumEnhancementLevel: number;
  readonly basePrice: number;
  readonly currentStock: number;
  readonly totalTrades: number;
  readonly minimumPrice: number;
  readonly maximumPrice: number;
  readonly lastSale: { readonly price: number; readonly timestamp: number } | null;
}

export interface NormalizedMarketReader {
  readSummaries(input: MarketSummariesRead): Promise<readonly NormalizedMarketSummary[]>;
  readListings(input: MarketItemRead): Promise<readonly NormalizedMarketListing[]>;
  readOrderBook(input: MarketEnhancedItemRead): Promise<readonly NormalizedMarketOrder[]>;
  readPriceHistory(input: MarketEnhancedItemRead): Promise<readonly NormalizedMarketPricePoint[]>;
  readCatalog(input: MarketCatalogRead): Promise<readonly NormalizedMarketCatalogItem[]>;
  readHotItems(input: MarketReadContext): Promise<readonly NormalizedHotMarketItem[]>;
  readRegistrations(input: MarketReadContext): Promise<readonly NormalizedMarketRegistration[]>;
}

export interface MarketReadContext {
  readonly region: PearlAbyssRequestInput["region"];
  readonly locale: PearlAbyssRequestInput["locale"];
}

export interface MarketSummariesRead extends MarketReadContext {
  readonly itemIds: readonly number[];
}

export interface MarketItemRead extends MarketReadContext {
  readonly itemId: number;
}

export interface MarketEnhancedItemRead extends MarketItemRead {
  readonly enhancementLevel: number;
}

export interface MarketCatalogRead extends MarketReadContext {
  readonly category: NormalizedMarketCategory | null;
}

export interface NormalizedMarketOrder {
  readonly buyOrders: number;
  readonly price: number;
  readonly sellOrders: number;
}

export interface NormalizedMarketPricePoint {
  readonly offsetFromLatest: number;
  readonly price: number;
}

export interface NormalizedMarketCatalogItem extends NormalizedMarketSummary {
  readonly category: NormalizedMarketCategory;
}

export interface NormalizedHotMarketItem {
  readonly amount: number;
  readonly direction: "UP" | "DOWN" | "UNKNOWN";
  readonly listings: readonly NormalizedMarketListing[];
  readonly summary: NormalizedMarketSummary;
}

export interface NormalizedMarketRegistration {
  readonly enhancementLevel: number;
  readonly itemId: number;
  readonly price: number;
  readonly timestamp: number;
}

type RequestLifecycleOutcome =
  | { readonly ok: true; readonly value: PearlAbyssCapabilityResponse }
  | { readonly ok: false; readonly error: PearlAbyssUpstreamError };

interface RequestLifecycleContext {
  readonly lease: ConnectionLease | null;
  readonly outcome: RequestLifecycleOutcome | null;
}

type FetchOutcome =
  | { readonly timedOut: true; readonly settled: Promise<void> }
  | { readonly timedOut: false; readonly value: PearlAbyssCapabilityResponse };

export function createPearlAbyssMarketReader(input: PearlAbyssMarketReaderInput): NormalizedMarketReader {
  const coordinator = new PearlAbyssRequestCoordinator(input);
  return {
    readSummaries: async ({ region, locale, itemIds }) => {
      const response = await coordinator.execute({ capability: "summaries", region, locale, itemIds });
      return requireCapability(response, "summaries").rows;
    },
    readListings: async ({ region, locale, itemId }) => {
      const response = await coordinator.execute({ capability: "listings", region, locale, itemId });
      return requireCapability(response, "listings").rows.map(normalizeListing);
    },
    readOrderBook: async ({ region, locale, itemId, enhancementLevel }) => {
      const response = await coordinator.execute({
        capability: "order-book",
        region,
        locale,
        itemId,
        enhancementLevel,
      });
      return requireCapability(response, "order-book").rows;
    },
    readPriceHistory: async ({ region, locale, itemId, enhancementLevel }) => {
      const response = await coordinator.execute({
        capability: "price-history",
        region,
        locale,
        itemId,
        enhancementLevel,
      });
      return requireCapability(response, "price-history").rows;
    },
    readCatalog: async ({ region, locale, category }) => {
      const pairs = pearlAbyssCategoriesFor(category);
      const responses = await coordinator.executeMany(
        pairs.map((pair) => ({
          capability: "catalog" as const,
          region,
          locale,
          mainCategory: pair.main,
          subCategory: pair.sub,
        })),
      );
      const itemsById = new Map<number, NormalizedMarketCatalogItem>();
      for (const response of responses) {
        for (const row of requireCapability(response, "catalog").rows) {
          itemsById.set(row.itemId, {
            itemId: row.itemId,
            basePrice: row.basePrice,
            currentStock: row.currentStock,
            totalTrades: row.totalTrades,
            category: { main: row.mainCategory, sub: row.subCategory },
          });
        }
      }
      return [...itemsById.values()].sort((left, right) => left.itemId - right.itemId);
    },
    readHotItems: async ({ region, locale }) => {
      const response = await coordinator.execute({ capability: "hot-items", region, locale });
      return requireCapability(response, "hot-items").rows.map(normalizeHotItem);
    },
    readRegistrations: async ({ region, locale }) => {
      const response = await coordinator.execute({ capability: "registrations", region, locale });
      return requireCapability(response, "registrations").rows.map((row) => ({
        itemId: row.itemId,
        enhancementLevel: row.enhancementLevel,
        price: row.price,
        timestamp: row.registeredTimestamp,
      }));
    },
  };
}

class PearlAbyssRequestCoordinator {
  private readonly reserveBudget: InvocationBudgetReservation;
  private readonly reserveMarketSummary: MarketSummaryReservation | undefined;
  private readonly connectionPool = new BoundedConnectionPool(MAXIMUM_OUTBOUND_CONNECTIONS);
  private readonly pending = new Map<string, Promise<PearlAbyssCapabilityResponse>>();
  private readonly timeoutMs: number;

  public constructor(private readonly input: PearlAbyssMarketReaderInput) {
    this.reserveBudget = input.reserveBudget ?? invocationBudgetReservation(input.budget ?? new InvocationBudget());
    this.reserveMarketSummary = input.reserveMarketSummary;
    this.timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError("Pearl Abyss timeout must be a positive safe integer");
    }
  }

  public execute(requestInput: PearlAbyssRequestInput): Promise<PearlAbyssCapabilityResponse> {
    return this.executeMany([requestInput]).then((responses) => requireFirst(responses));
  }

  public async executeMany(
    inputs: readonly PearlAbyssRequestInput[],
  ): Promise<readonly PearlAbyssCapabilityResponse[]> {
    const planned = inputs.map((input) => this.plan(input));
    const distinctNew = [
      ...new Map(
        planned.filter((entry) => !this.pending.has(entry.key)).map((entry) => [entry.key, entry] as const),
      ).values(),
    ];
    const admission = this.reserveAndStart(distinctNew);
    for (const entry of distinctNew) {
      this.pending.set(entry.key, this.observe(admission.then(() => this.start(entry.request))));
    }
    return Promise.all(planned.map((entry) => requirePending(this.pending, entry.key)));
  }

  private async reserveAndStart(
    entries: readonly { readonly key: string; readonly request: PearlAbyssRequest }[],
  ): Promise<void> {
    for (const entry of entries) {
      if (entry.request.capability !== "summaries") continue;
      const admission = await this.reserveMarketSummary?.({
        region: entry.request.region,
        locale: entry.request.locale,
        itemIds: entry.request.itemIds,
      });
      if (admission?.ok === false) throw new MarketSummaryBudgetExceededError(admission.limit);
    }
    const admission = await this.reserveBudget(entries.length);
    if (!admission.ok) {
      throw new PearlAbyssUpstreamError(
        "upstream/budget-exceeded",
        "Pearl Abyss work exceeds the remaining Worker invocation budget",
      );
    }
  }

  private plan(input: PearlAbyssRequestInput) {
    const built = buildPearlAbyssRequest(input);
    if (!built.ok) throw new TypeError(built.error.message);
    return { key: `${built.value.url}\n${built.value.body}`, request: built.value };
  }

  private async start(request: PearlAbyssRequest): Promise<PearlAbyssCapabilityResponse> {
    const lifecycle = createActor(
      createRequestLifecycleMachine(request, this.connectionPool, this.input, this.timeoutMs),
    );
    lifecycle.start();
    const outcome = await toPromise(lifecycle);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  private async observe(operation: Promise<PearlAbyssCapabilityResponse>): Promise<PearlAbyssCapabilityResponse> {
    try {
      const response = await operation;
      this.input.onRequestSettled?.("succeeded");
      return response;
    } catch (error: unknown) {
      this.input.onRequestSettled?.(failedSettlement(error));
      throw error;
    }
  }
}

function failedSettlement(error: unknown): Exclude<PearlAbyssRequestSettlement, "succeeded"> {
  if (error instanceof MarketSummaryBudgetExceededError) return "refused";
  if (error instanceof PearlAbyssUpstreamError) {
    if (error.code === "upstream/budget-exceeded") return "refused";
    if (error.code === "upstream/rate-limited" || error.code === "upstream/queue-full") return "rate-limited";
  }
  return "failed";
}

function createRequestLifecycleMachine(
  request: PearlAbyssRequest,
  connections: BoundedConnectionPool,
  input: PearlAbyssMarketReaderInput,
  timeoutMs: number,
) {
  return setup({
    schemas: { context: types<RequestLifecycleContext>(), output: types<RequestLifecycleOutcome>() },
    actors: {
      acquireConnection: createAsyncLogic({ run: async () => connections.acquire() }),
      acquirePermit: createAsyncLogic({ run: async () => input.limiter.limit(PEARL_ABYSS_RATE_LIMIT_KEY) }),
      executeFetch: createAsyncLogic({ run: async () => executePearlAbyssFetch(request, input, timeoutMs) }),
    },
    actions: {
      releaseConnection: (args: { context: RequestLifecycleContext }) => ({
        context: {
          lease: (({ context }) => {
            context.lease?.release();
            return null;
          })(args),
        } satisfies Partial<RequestLifecycleContext>,
      }),
    },
  }).createMachine({
    id: "pearl-abyss-request",
    context: { lease: null, outcome: null },
    initial: "planned",
    states: {
      planned: { always: { target: "waitingForConnection" } },
      waitingForConnection: {
        invoke: {
          src: "acquireConnection",
          onDone: (args) => {
            const context = {
              ...args.context,
              ...({ lease: (({ event }) => event.output)(args) } satisfies Partial<RequestLifecycleContext>),
            };
            return { target: "limiting", context };
          },
          onError: (args) => {
            const context = {
              ...args.context,
              ...({
                outcome: (() =>
                  lifecycleFailure("upstream/unavailable", "Pearl Abyss connection acquisition failed"))(),
              } satisfies Partial<RequestLifecycleContext>),
            };
            return { target: "failed", context };
          },
        },
      },
      limiting: {
        invoke: {
          src: "acquirePermit",
          onDone: (args) => {
            if ((({ event }) => event.output.success)(args)) {
              return { target: "fetching" };
            }
            const context = {
              ...args.context,
              ...({
                outcome: (() => lifecycleFailure("upstream/rate-limited", "Pearl Abyss request rate limited"))(),
              } satisfies Partial<RequestLifecycleContext>),
            };
            return { target: "failed", context };
          },
          onError: (args) => {
            const context = {
              ...args.context,
              ...({
                outcome: (() => lifecycleFailure("upstream/rate-limited", "Pearl Abyss limiter unavailable"))(),
              } satisfies Partial<RequestLifecycleContext>),
            };
            return { target: "failed", context };
          },
        },
      },
      fetching: {
        invoke: {
          src: "executeFetch",
          onDone: (args) => {
            if ((({ event }) => event.output.timedOut)(args)) {
              const context = {
                ...args.context,
                ...({
                  lease: (({ context, event }) => {
                    if (!event.output.timedOut) return context.lease;
                    context.lease?.releaseAfter(event.output.settled);
                    return null;
                  })(args),
                  outcome: (() => lifecycleFailure("upstream/timeout", "Pearl Abyss request timed out"))(),
                } satisfies Partial<RequestLifecycleContext>),
              };
              return { target: "failed", context };
            }
            const context = {
              ...args.context,
              ...({
                outcome: (({ event }) =>
                  event.output.timedOut ? null : { ok: true as const, value: event.output.value })(args),
              } satisfies Partial<RequestLifecycleContext>),
            };
            return { target: "succeeded", context };
          },
          onError: (args) => {
            const context = {
              ...args.context,
              ...({
                outcome: (({ event }) => ({
                  ok: false,
                  error:
                    event.error instanceof PearlAbyssUpstreamError
                      ? event.error
                      : new PearlAbyssUpstreamError("upstream/unavailable", "Pearl Abyss request failed"),
                }))(args),
              } satisfies Partial<RequestLifecycleContext>),
            };
            return { target: "failed", context };
          },
        },
      },
      succeeded: {
        type: "final",
        entry: (args) => {
          const context = { ...args.context, ...args.actions.releaseConnection(args).context };
          return { context };
        },
      },
      failed: {
        type: "final",
        entry: (args) => {
          const context = { ...args.context, ...args.actions.releaseConnection(args).context };
          return { context };
        },
      },
    },
    output: ({ context }) => requireLifecycleOutcome(context.outcome),
  });
}

function lifecycleFailure(code: PearlAbyssUpstreamErrorCode, message: string): RequestLifecycleOutcome {
  return { ok: false, error: new PearlAbyssUpstreamError(code, message) };
}

function requireLifecycleOutcome(outcome: RequestLifecycleOutcome | null): RequestLifecycleOutcome {
  if (outcome === null) {
    return lifecycleFailure("upstream/unavailable", "Pearl Abyss request lifecycle ended without an outcome");
  }
  return outcome;
}

async function executePearlAbyssFetch(
  request: PearlAbyssRequest,
  input: PearlAbyssMarketReaderInput,
  timeoutMs: number,
): Promise<FetchOutcome> {
  const timed = await input.timeout.run(timeoutMs, (signal) => input.http.fetch(request, signal));
  if (timed.timedOut) return timed;
  if (timed.value.status < 200 || timed.value.status >= 300) {
    await cancelBody(timed.value.body);
    throw new PearlAbyssUpstreamError("upstream/unavailable", "Pearl Abyss returned an unsuccessful status");
  }
  const response = await readPearlAbyssResponseBody(timed.value);
  const decodedBody = decodePearlAbyssResponseBody(request, response);
  if (!decodedBody.ok) {
    throw new PearlAbyssUpstreamError("upstream/invalid-response", decodedBody.error.message);
  }
  const decoded = decodePearlAbyssPayload(request, decodedBody.value);
  if (!decoded.ok) {
    throw new PearlAbyssUpstreamError("upstream/invalid-response", decoded.error.message);
  }
  return { timedOut: false, value: decoded.value };
}

export async function readPearlAbyssResponseBody(response: PearlAbyssHttpResponse): Promise<Uint8Array> {
  const contentLength = Number(response.contentLength ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAXIMUM_PEARL_ABYSS_RESPONSE_BYTES) {
    await cancelBody(response.body);
    throw new PearlAbyssUpstreamError("upstream/invalid-response", "Pearl Abyss response exceeded the accepted size");
  }
  if (response.body === null) {
    throw new PearlAbyssUpstreamError("upstream/invalid-response", "Pearl Abyss response body was missing");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAXIMUM_PEARL_ABYSS_RESPONSE_BYTES) {
        await cancelReader(reader);
        throw new PearlAbyssUpstreamError(
          "upstream/invalid-response",
          "Pearl Abyss response exceeded the accepted size",
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Cancellation is cleanup; rejection must not replace the explicit upstream failure.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is cleanup; rejection must not replace the explicit upstream failure.
  }
}

function normalizeListing(row: {
  readonly minimumEnhancementLevel: number;
  readonly maximumEnhancementLevel: number;
  readonly basePrice: number;
  readonly currentStock: number;
  readonly totalTrades: number;
  readonly minimumPrice: number;
  readonly maximumPrice: number;
  readonly lastSalePrice: number;
  readonly lastSaleTimestamp: number;
}): NormalizedMarketListing {
  return {
    minimumEnhancementLevel: row.minimumEnhancementLevel,
    maximumEnhancementLevel: row.maximumEnhancementLevel,
    basePrice: row.basePrice,
    currentStock: row.currentStock,
    totalTrades: row.totalTrades,
    minimumPrice: row.minimumPrice,
    maximumPrice: row.maximumPrice,
    lastSale:
      row.lastSalePrice === 0 || row.lastSaleTimestamp === 0
        ? null
        : { price: row.lastSalePrice, timestamp: row.lastSaleTimestamp },
  };
}

function normalizeHotItem(row: PearlAbyssHotItem): NormalizedHotMarketItem {
  return {
    summary: {
      itemId: row.itemId,
      basePrice: row.basePrice,
      currentStock: row.currentStock,
      totalTrades: row.totalTrades,
    },
    listings: [normalizeListing(row)],
    direction: row.priceChangeDirectionCode === 1 ? "UP" : row.priceChangeDirectionCode === 2 ? "DOWN" : "UNKNOWN",
    amount: row.priceChangeAmount,
  };
}

function requireCapability<Capability extends PearlAbyssCapabilityResponse["capability"]>(
  response: PearlAbyssCapabilityResponse,
  capability: Capability,
): Extract<PearlAbyssCapabilityResponse, { readonly capability: Capability }> {
  if (response.capability !== capability) throw new TypeError("Pearl Abyss capability response mismatch");
  // SAFETY: The discriminant equality check proves response is the requested capability variant.
  return response as Extract<PearlAbyssCapabilityResponse, { readonly capability: Capability }>;
}

function requireFirst<Value>(values: readonly Value[]): Value {
  const value = values[0];
  if (value === undefined) throw new TypeError("Expected one Pearl Abyss response");
  return value;
}

function requirePending(
  pending: ReadonlyMap<string, Promise<PearlAbyssCapabilityResponse>>,
  key: string,
): Promise<PearlAbyssCapabilityResponse> {
  const value = pending.get(key);
  if (value === undefined) throw new TypeError("Pearl Abyss work was not admitted");
  return value;
}
