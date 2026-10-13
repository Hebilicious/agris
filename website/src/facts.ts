/**
 * Every cache window, rate limit and request limit the site prints, read from where the code keeps it. Pages, the
 * example checks and `/llms.txt` import these from here and nowhere else, so when an export is renamed or a setting
 * moves, this is the one file that changes. Nothing here is typed by hand.
 *
 * Cache windows are per deployment: `SELF_HOSTED.cacheFreshness` is what a self-hosted gateway runs with by default,
 * and `DEMO.cacheFreshness` is the shared demo's. A deployment changes any one value with its own `CACHE_*` variable on
 * the gateway (`CACHE_SETTING_NAMES` in `@agris/core`).
 *
 * Build time only. The figure's browser script gets its numbers from the data block the build writes, so it never
 * loads the gateway's code.
 */
import type { CacheFreshnessPolicy } from "./deployment.ts";

export {
  createPublicGatewayRequestProtocol,
  INTROSPECTION_DOCUMENT_LIMITS,
  MAXIMUM_GATEWAY_REQUEST_BYTES,
  PUBLIC_DOCUMENT_LIMITS,
  type GatewayCachePolicy,
} from "@agris/core";

export {
  DEMO,
  LIMIT_SETTINGS,
  rateOf,
  SELF_HOSTED,
  type CacheFreshnessPolicy,
  type DemoFacts,
  type DeploymentFacts,
  type LimitSetting,
  type Rate,
} from "./deployment.ts";

/** One row of a freshness table: the fields that share a window, and the window. */
export interface FreshnessRow {
  readonly fresh: number;
  readonly stale: number;
  readonly fields: readonly string[];
}

/** A policy's windows grouped by window, shortest first, with each window's fields sorted. */
export function freshnessRowsOf(policy: CacheFreshnessPolicy): readonly FreshnessRow[] {
  const rows = new Map<string, { fresh: number; stale: number; fields: string[] }>();
  for (const [coordinate, window] of Object.entries(policy.coordinates)) {
    const fresh = Math.max(window.maxAgeSeconds, policy.minimumSeconds);
    const stale = Math.max(window.staleWhileRevalidateSeconds, policy.minimumSeconds);
    const key = `${fresh}/${stale}`;
    const row = rows.get(key) ?? { fresh, stale, fields: [] };
    row.fields.push(coordinate);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((row) => ({ ...row, fields: row.fields.sort() }))
    .sort((a, b) => a.fresh - b.fresh || a.stale - b.stale);
}
