import type { PearlAbyssCoordinator } from "./index.js";

/**
 * The bindings the market Worker reads. A deployment configuration, this repository's or a host's, must provide them;
 * `infra/src/smoke/env.check.ts` proves the smoke stage, which deploys this entrypoint as a host does, provides them.
 */
export interface MarketEnv {
  readonly MARKET_ENVIRONMENT: string;
  /**
   * Global active Pearl Abyss request limit per upstream host, as a JSON number or text. Absent or `0` sets no limit of
   * its own: a coordinator then runs at most `UNLIMITED_CONCURRENT_PEARL_ABYSS_REQUESTS` (1,000) at once.
   */
  readonly PA_MAX_CONCURRENT_REQUESTS?: number | string;
  /** This Worker's own `PearlAbyssCoordinator` Durable Object class. */
  readonly PA_COORDINATOR: DurableObjectNamespace<PearlAbyssCoordinator>;
  /**
   * Burst backstop for Pearl Abyss calls, counted per upstream host: each region's coordinator consults it for its own
   * host. Absent sets no rate limit.
   */
  readonly PA_RATE_LIMITER?: RateLimit;
  /**
   * The Worker's `limits.subrequests`, which a request that arrives without the gateway's budget may spend; absent is
   * 50.
   */
  readonly SUBREQUEST_LIMIT?: string;
}
