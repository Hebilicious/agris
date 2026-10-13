// This module imports nothing, so Node and the site load it by its subpath (`@agris/invocation-budget/subrequest-limit`)
// without a TypeScript loader; the deploy settings read the default from here.

/**
 * The subrequests one Worker invocation may make when the deployment states no `SUBREQUEST_LIMIT`. The gateway, cache
 * and market Workers deploy with `limits.subrequests` equal to their `SUBREQUEST_LIMIT`, so the budget and the
 * platform's limit agree; the catalog Worker makes no subrequests and sets none.
 */
export const DEFAULT_SUBREQUEST_LIMIT = 50;

/** The most distinct market-summary batches one operation may read, whatever the subrequest limit. */
export const CENTRAL_MARKET_SUMMARY_REQUEST_BUDGET = 6;

/**
 * Subrequests an operation that reads market summaries spends before its first Pearl Abyss read: one Service Binding
 * call to the catalog subgraph and one to the market subgraph.
 */
const SUBGRAPH_CALLS_BEFORE_SUMMARIES = 2;

/**
 * BOUNDARY: A deployment's `SUBREQUEST_LIMIT` binding: the subrequests one invocation may make, which the Worker's
 * `limits.subrequests` must match. Absent is `DEFAULT_SUBREQUEST_LIMIT`; anything but a positive whole number, as text
 * or a JSON number, throws, so a bad configuration fails instead of being ignored.
 */
export function subrequestLimitFromBinding(value: unknown): number {
  if (value === undefined) return DEFAULT_SUBREQUEST_LIMIT;
  const limit = typeof value === "string" && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("SUBREQUEST_LIMIT must be a positive whole number");
  }
  return limit;
}

/**
 * How many distinct market-summary batches one operation may read under `subrequestLimit`: six, or fewer when the
 * limit leaves less room after the subgraph calls, so a summary query meets a `QUERY_BUDGET_EXCEEDED` error rather
 * than the platform's subrequest limit.
 */
export function marketSummaryRequestLimitFor(subrequestLimit: number): number {
  return Math.max(
    0,
    Math.min(CENTRAL_MARKET_SUMMARY_REQUEST_BUDGET, subrequestLimit - SUBGRAPH_CALLS_BEFORE_SUMMARIES),
  );
}
