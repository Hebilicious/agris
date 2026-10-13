import * as Cloudflare from "alchemy/Cloudflare";

import type { DeploymentSettings, RateLimitSetting } from "../settings.ts";
import { bundleOptions, compatibility, localPort, observability, privateSurface, subrequestLimit } from "../stack.ts";

function rateLimit(name: string, setting: RateLimitSetting) {
  return Cloudflare.RateLimit(name, {
    namespaceId: setting.namespaceId,
    simple: { limit: setting.limit, period: setting.period },
  });
}

/**
 * The public gateway's props in one stage: its `workers.dev` address and any hostname the stage adds, its rate
 * limiters, and its plain-text variables, among them the exact `ADMISSION_*` limits its `GatewayAdmission` objects keep
 * (`worker.ts` declares the class). A limit the stage turned off binds no limiter and sets no exact limit, and the
 * gateway then limits nothing there.
 */
export function gatewayProps(settings: DeploymentSettings) {
  return {
    name: settings.names.gateway,
    main: new URL("./worker.ts", import.meta.url).href,
    compatibility: compatibility(),
    build: bundleOptions(),
    dev: localPort(8790),
    workersDev: { enabled: settings.workersDev, previewsEnabled: false },
    ...(settings.domain === null ? {} : { domain: settings.domain }),
    // Runtime admission counts Service Binding calls and Pearl Abyss requests against this value.
    limits: subrequestLimit(settings.subrequestLimit).limits,
    observability: observability(settings.sampling),
    env: {
      ...settings.gatewayVariables,
      ...subrequestLimit(settings.subrequestLimit).variable,
      ...(settings.clientRateLimit === null
        ? {}
        : { CLIENT_RATE_LIMITER: rateLimit("CLIENT_RATE_LIMITER", settings.clientRateLimit) }),
      ...(settings.globalRateLimit === null
        ? {}
        : { GLOBAL_RATE_LIMITER: rateLimit("GLOBAL_RATE_LIMITER", settings.globalRateLimit) }),
    },
  };
}

/** The cache Worker's props in one stage: private, reached only by the gateway, with Workers Cache on. */
export function gatewayCacheProps(settings: DeploymentSettings) {
  return {
    name: settings.names.cache,
    main: new URL("./cache-worker.ts", import.meta.url).href,
    compatibility: compatibility(),
    build: bundleOptions(),
    dev: localPort(8793),
    workersDev: privateSurface(),
    limits: subrequestLimit(settings.subrequestLimit).limits,
    observability: observability(settings.sampling),
    env: subrequestLimit(settings.subrequestLimit).variable,
  };
}
