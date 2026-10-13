import { DEFAULT_SUBREQUEST_LIMIT, marketSummaryRequestLimitFor } from "./subrequest-limit.js";

export { BoundedConnectionPool, type ConnectionLease } from "./bounded-connection-pool.js";
export {
  CENTRAL_MARKET_SUMMARY_REQUEST_BUDGET,
  DEFAULT_SUBREQUEST_LIMIT,
  marketSummaryRequestLimitFor,
  subrequestLimitFromBinding,
} from "./subrequest-limit.js";

export interface InvocationBudgetSnapshot {
  readonly limit: number;
  readonly remaining: number;
  readonly used: number;
}

export type InvocationBudgetAdmission =
  | { readonly ok: true; readonly snapshot: InvocationBudgetSnapshot }
  | { readonly ok: false; readonly code: "invocation-budget/exceeded"; readonly snapshot: InvocationBudgetSnapshot };

export type InvocationBudgetReservation = (count: number) => Promise<InvocationBudgetAdmission>;

export interface MarketSummaryRequestKey {
  readonly itemIds: readonly number[];
  readonly locale: string;
  readonly region: string;
}

export type MarketSummaryAdmission =
  | { readonly ok: true; readonly reused: boolean }
  | { readonly ok: false; readonly code: "market-summary-budget/exceeded"; readonly limit: number };

export type MarketSummaryReservation = (key: MarketSummaryRequestKey) => Promise<MarketSummaryAdmission>;

export interface MarketSummaryBudgetTelemetryEvent {
  readonly admittedCount: number;
  readonly count: 1;
  readonly event: "market-summary-operation-budget";
  readonly limit: number;
  readonly outcome: "admitted" | "rejected" | "reused";
}

export interface MarketSummaryBudgetTelemetry {
  record(event: MarketSummaryBudgetTelemetryEvent): void;
}

export class MarketSummaryBudgetExceededError extends Error {
  public readonly code = "market-summary-budget/exceeded";

  /** How many distinct batches the operation was allowed. */
  public readonly limit: number;

  public constructor(limit: number) {
    super("Market summary work exceeds the operation request budget");
    this.name = "MarketSummaryBudgetExceededError";
    this.limit = limit;
  }
}

export class MarketSummaryOperationBudget {
  private readonly admittedKeys = new Set<string>();

  public constructor(
    private readonly limit: number = marketSummaryRequestLimitFor(DEFAULT_SUBREQUEST_LIMIT),
    private readonly telemetry?: MarketSummaryBudgetTelemetry,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Market summary budget must be non-negative");
  }

  public reserve(key: MarketSummaryRequestKey): MarketSummaryAdmission {
    const normalized = normalizedMarketSummaryKey(key);
    if (this.admittedKeys.has(normalized)) {
      this.record("reused");
      return { ok: true, reused: true };
    }
    if (this.admittedKeys.size >= this.limit) {
      this.record("rejected");
      return { ok: false, code: "market-summary-budget/exceeded", limit: this.limit };
    }
    this.admittedKeys.add(normalized);
    this.record("admitted");
    return { ok: true, reused: false };
  }

  private record(outcome: MarketSummaryBudgetTelemetryEvent["outcome"]): void {
    try {
      this.telemetry?.record({
        event: "market-summary-operation-budget",
        count: 1,
        outcome,
        admittedCount: this.admittedKeys.size,
        limit: this.limit,
      });
    } catch {
      // Admission cannot depend on its observational telemetry sink.
    }
  }
}

export class InvocationBudget {
  private used = 0;

  public constructor(private readonly limit: number = DEFAULT_SUBREQUEST_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invocation budget must be non-negative");
  }

  public reserve(count: number): InvocationBudgetAdmission {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("Reserved subrequests must be non-negative");
    if (this.used + count > this.limit) {
      return { ok: false, code: "invocation-budget/exceeded", snapshot: this.snapshot() };
    }
    this.used += count;
    return { ok: true, snapshot: this.snapshot() };
  }

  public snapshot(): InvocationBudgetSnapshot {
    return { limit: this.limit, used: this.used, remaining: this.limit - this.used };
  }
}

export function invocationBudgetReservation(budget: InvocationBudget): InvocationBudgetReservation {
  return async (count) => budget.reserve(count);
}

export function marketSummaryReservation(budget: MarketSummaryOperationBudget): MarketSummaryReservation {
  return async (key) => budget.reserve(key);
}

function normalizedMarketSummaryKey(key: MarketSummaryRequestKey): string {
  if (key.region.length === 0 || key.locale.length === 0) {
    throw new TypeError("Market summary region and locale must not be empty");
  }
  const itemIds = [...new Set(key.itemIds)].sort((left, right) => left - right);
  if (itemIds.length === 0 || itemIds.some((itemId) => !Number.isSafeInteger(itemId) || itemId <= 0)) {
    throw new TypeError("Market summary Item IDs must be positive safe integers");
  }
  return JSON.stringify([key.region, key.locale, itemIds]);
}
