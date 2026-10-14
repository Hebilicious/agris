import * as Cloudflare from "alchemy/Cloudflare";

import type { DeploymentSettings } from "../settings.ts";
import { bundleOptions, compatibility, localPort, observability, privateSurface, subrequestLimit } from "../stack.ts";

/**
 * The market Worker's props in one stage: private, reached only by the gateway, with the Pearl Abyss limits its
 * coordinators read. A stage without a Pearl Abyss rate limit binds no `PA_RATE_LIMITER`, and the coordinators then
 * limit no rate; `PA_MAX_CONCURRENT_REQUESTS` of `0` sets no concurrency limit of its own (at most 1,000 at once).
 */
export function marketProps(settings: DeploymentSettings) {
  const rateLimit = settings.pearlAbyssRateLimit;
  return {
    name: settings.names.market,
    main: new URL("./worker.ts", import.meta.url).href,
    compatibility: compatibility(),
    build: bundleOptions(),
    dev: localPort(8791),
    workersDev: privateSurface(),
    // A request that arrives without the gateway's budget admits its Pearl Abyss fetches against this value.
    limits: subrequestLimit(settings.subrequestLimit).limits,
    observability: observability(settings.sampling),
    env: {
      MARKET_ENVIRONMENT: "production",
      ...subrequestLimit(settings.subrequestLimit).variable,
      PA_MAX_CONCURRENT_REQUESTS: String(settings.pearlAbyssConcurrency),
      ...(rateLimit === null
        ? {}
        : {
            PA_RATE_LIMITER: Cloudflare.RateLimit("PA_RATE_LIMITER", {
              namespaceId: rateLimit.namespaceId,
              simple: { limit: rateLimit.limit, period: rateLimit.period },
            }),
          }),
    },
  };
}
