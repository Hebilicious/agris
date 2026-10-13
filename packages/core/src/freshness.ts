/** How long the edge's copy of a price answer counts as fresh. */
const EDGE_FRESH_SECONDS = 60;
/** Longer than a refresh takes to reach Pearl Abyss and store its answer (2.4 to 5.9 s measured in production). */
const REFRESH_MARGIN_SECONDS = 10;
/** How much sooner the browser's copy expires than a page asks again. */
const BROWSER_MARGIN_SECONDS = 5;

const REFRESH_INTERVAL_SECONDS = EDGE_FRESH_SECONDS + REFRESH_MARGIN_SECONDS;

/**
 * How fresh Central Market prices stay on their way from Pearl Abyss to the page. The gateway's cache policy, a host's
 * browser cache header and its page all read these numbers, and they are derived from each other so they cannot
 * drift apart:
 *
 * - An open, focused page asks again every `refreshIntervalSeconds`: just after the edge's copy stops being fresh,
 *   with a margin for the refresh the previous request started. Every request therefore finds a stale copy, gets it at
 *   once, and starts the next refresh, so a page alone sees prices about one interval old.
 * - The edge answers from its copy for `edge.maxAgeSeconds`, then for `edge.staleWhileRevalidateSeconds` more while it
 *   refreshes in the background. That window outlasts the refresh interval, so a page's next request always finds a
 *   copy to answer at once, and Pearl Abyss is asked at most once per freshness period per data centre.
 * - The browser keeps its copy for `browserMaxAgeSeconds`, less than the refresh interval: a reload soon after reuses
 *   it, while every refresh still reaches the edge.
 */
export const MARKET_PRICE_FRESHNESS = {
  edge: { maxAgeSeconds: EDGE_FRESH_SECONDS, staleWhileRevalidateSeconds: REFRESH_INTERVAL_SECONDS },
  refreshIntervalSeconds: REFRESH_INTERVAL_SECONDS,
  browserMaxAgeSeconds: REFRESH_INTERVAL_SECONDS - BROWSER_MARGIN_SECONDS,
} as const;
