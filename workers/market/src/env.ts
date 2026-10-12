import type { PearlAbyssCoordinator } from "./index.js";

/**
 * The bindings the market Worker reads. A deployment configuration, this repository's or a host's, must provide them;
 * `config-env.check.ts` proves this repository's `cloudflare.config.ts` does.
 */
export interface MarketEnv {
  readonly MARKET_ENVIRONMENT: string;
  /** Global active Pearl Abyss request limit per upstream host. */
  readonly PA_MAX_CONCURRENT_REQUESTS: number;
  /** This Worker's own `PearlAbyssCoordinator` Durable Object class. */
  readonly PA_COORDINATOR: DurableObjectNamespace<PearlAbyssCoordinator>;
  /** Burst backstop for Pearl Abyss calls. */
  readonly PA_RATE_LIMITER: RateLimit;
}
