/**
 * The deployed limits and cache freshness the site states, in one place. They are read from the deploy definition
 * (`infra/src/settings.ts` in the repository), never typed in: `SELF_HOSTED` is what a self-hosted stage deploys with
 * nothing set, and `DEMO` is the shared demo. `tests/features/site-deployment-facts.feature` checks that each one is
 * what the gateway and market Workers would run with.
 */
import {
  DEMO_SETTINGS,
  DEPLOY_SETTING,
  SELF_HOSTED_DEFAULTS,
  selfHostedSettings,
  type DeploymentSettings,
} from "@agris/infra/settings";
import { CACHE_SETTING, type CacheFreshnessOverride, type CacheFreshnessPolicy } from "@agris/core/cache-freshness";
import { documentLimitsFromBindings, QUERY_LIMIT_SETTING } from "@agris/core/document-limits";

export type { CacheFreshnessOverride, CacheFreshnessPolicy, CoordinateFreshness } from "@agris/core/cache-freshness";

export interface Rate {
  readonly limit: number;
  readonly period: number;
}

export interface DeploymentFacts {
  /** `CLIENT_RATE_LIMITER` on the gateway: requests per IP, per Cloudflare location, or none. */
  readonly clientRateLimit: Rate | null;
  /** `GLOBAL_RATE_LIMITER` on the gateway: requests per Cloudflare location, or none. */
  readonly globalRateLimit: Rate | null;
  /** The exact market admission (`MARKET_CLIENT_LIMIT_*`): market executions per IP, counted exactly, or none. */
  readonly marketClientLimit: Rate | null;
  /** The deployment's `CACHE_*` settings, as changes to the defaults, or `null` when it sets none. */
  readonly cacheFreshnessOverride: CacheFreshnessOverride | null;
  /** The cache freshness the gateway runs with: `DEFAULT_CACHE_FRESHNESS` with `cacheFreshnessOverride` applied. */
  readonly cacheFreshness: CacheFreshnessPolicy;
  /** `cacheFreshness.minimumSeconds`: the shortest window a storable answer gets, `0` for none. */
  readonly freshnessFloorSeconds: number;
  /** `PA_MAX_CONCURRENT_REQUESTS` on the market Worker: distinct Pearl Abyss requests at once, per host. */
  readonly pearlAbyssConcurrency: number;
  /** `PA_RATE_LIMITER` on the market Worker: the burst backstop on Pearl Abyss calls, per Pearl Abyss region. */
  readonly pearlAbyssRateLimit: Rate;
  /** `SUBREQUEST_LIMIT`: subrequests per invocation. */
  readonly subrequestLimit: number;
}

/** The demo always limits each visitor, so its facts say so in their type. */
export interface DemoFacts extends DeploymentFacts {
  readonly clientRateLimit: Rate;
}

function rateOfSetting(setting: Rate | null): Rate | null {
  return setting === null ? null : { limit: setting.limit, period: setting.period };
}

function required(setting: Rate | null, what: string): Rate {
  const rate = rateOfSetting(setting);
  if (rate === null) throw new TypeError(`The site states ${what}, which this deployment does not set.`);
  return rate;
}

/** What the site states about one deployment's settings. */
export function deploymentFacts(settings: DeploymentSettings): DeploymentFacts {
  return {
    clientRateLimit: rateOfSetting(settings.clientRateLimit),
    globalRateLimit: rateOfSetting(settings.globalRateLimit),
    marketClientLimit:
      settings.marketClientLimit === null
        ? null
        : { limit: settings.marketClientLimit.limit, period: settings.marketClientLimit.periodSeconds },
    cacheFreshnessOverride: settings.cacheOverride,
    cacheFreshness: settings.cacheFreshness,
    freshnessFloorSeconds: settings.cacheFreshness.minimumSeconds,
    pearlAbyssConcurrency: settings.pearlAbyssConcurrency,
    pearlAbyssRateLimit: required(settings.pearlAbyssRateLimit, "a Pearl Abyss rate limit"),
    subrequestLimit: settings.subrequestLimit,
  };
}

/** A self-hosted deployment with nothing set. */
export const SELF_HOSTED: DeploymentFacts = deploymentFacts(selfHostedSettings("production", {}));

/** The shared demo. */
export const DEMO: DemoFacts = {
  ...deploymentFacts(DEMO_SETTINGS),
  clientRateLimit: required(DEMO_SETTINGS.clientRateLimit, "a client rate limit"),
};

/** `10 a minute`, `100 per 10 s`. */
export function rateOf({ limit, period }: Rate): string {
  return period === 60 ? `${limit} a minute` : `${limit} per ${period} s`;
}

/**
 * One limit a deployment sets with one environment variable, as a settings table shows it: what a self-hosted
 * deployment runs with when the variable is unset, and what the demo runs with. A value of `null` means the limit is
 * off.
 */
export interface LimitSetting {
  /** The environment variable of the deploy command that sets it, such as `CLIENT_RATE_LIMIT_REQUESTS`. */
  readonly variable: string;
  /** What it limits, in plain words. */
  readonly label: string;
  /** What its number counts: `requests`, `seconds`, `calls`, `subrequests`, `fields`… */
  readonly unit: string;
  /** A self-hosted deployment's value when the variable is unset; `null` when the limit is off by default. */
  readonly selfHosted: number | null;
  /** The shared demo's value; `null` when the demo sets no such limit. */
  readonly demo: number | null;
  /** The value that turns the limit off, or `null` when it cannot be turned off. */
  readonly disable: string | null;
}

/** A limit's number, or `null` when it is off: a rate of none, a `0` that means no limit, an unlimited query size. */
function limitOrOff(value: number | null | undefined): number | null {
  return value === null || value === undefined || value === 0 || !Number.isFinite(value) ? null : value;
}

/** Every limit a deployment can set, with the self-hosted default and the demo's value, in the order a table lists them. */
export function limitSettingsOf(selfHosted: DeploymentSettings, demo: DeploymentSettings): readonly LimitSetting[] {
  const rows: LimitSetting[] = [];
  const rate = (
    pick: (settings: DeploymentSettings) => Rate | null,
    fallbackPeriod: number,
    requests: { variable: string; label: string; unit: string },
    period: { variable: string; label: string },
  ) => {
    rows.push({
      ...requests,
      selfHosted: limitOrOff(pick(selfHosted)?.limit),
      demo: limitOrOff(pick(demo)?.limit),
      disable: "0",
    });
    rows.push({
      ...period,
      unit: "seconds",
      selfHosted: pick(selfHosted)?.period ?? fallbackPeriod,
      demo: pick(demo)?.period ?? fallbackPeriod,
      disable: null,
    });
  };
  rate(
    (settings) => settings.clientRateLimit,
    SELF_HOSTED_DEFAULTS.clientRateLimit.period,
    { variable: DEPLOY_SETTING.clientRateLimitRequests, label: "Requests per visitor", unit: "requests" },
    { variable: DEPLOY_SETTING.clientRateLimitPeriod, label: "Period of the per-visitor limit" },
  );
  rate(
    (settings) => settings.globalRateLimit,
    SELF_HOSTED_DEFAULTS.globalRateLimit.period,
    {
      variable: DEPLOY_SETTING.globalRateLimitRequests,
      label: "Requests per Cloudflare location",
      unit: "requests",
    },
    { variable: DEPLOY_SETTING.globalRateLimitPeriod, label: "Period of the per-location limit" },
  );
  rate(
    (settings) =>
      settings.marketClientLimit === null
        ? null
        : { limit: settings.marketClientLimit.limit, period: settings.marketClientLimit.periodSeconds },
    SELF_HOSTED_DEFAULTS.marketClientLimit.periodSeconds,
    {
      variable: DEPLOY_SETTING.marketClientLimitRequests,
      label: "Market queries per visitor, counted exactly",
      unit: "requests",
    },
    { variable: DEPLOY_SETTING.marketClientLimitPeriod, label: "Period of the exact market limit" },
  );
  rate(
    (settings) => settings.pearlAbyssRateLimit,
    SELF_HOSTED_DEFAULTS.pearlAbyssRateLimit.period,
    {
      variable: DEPLOY_SETTING.pearlAbyssRateLimitRequests,
      label: "Pearl Abyss calls, per server",
      unit: "calls",
    },
    { variable: DEPLOY_SETTING.pearlAbyssRateLimitPeriod, label: "Period of the Pearl Abyss limit" },
  );
  rows.push({
    variable: DEPLOY_SETTING.pearlAbyssConcurrency,
    label: "Pearl Abyss calls at once, per server",
    unit: "calls",
    selfHosted: limitOrOff(selfHosted.pearlAbyssConcurrency),
    demo: limitOrOff(demo.pearlAbyssConcurrency),
    disable: "0",
  });
  rows.push({
    variable: DEPLOY_SETTING.subrequestLimit,
    label: "Subrequests per request",
    unit: "subrequests",
    selfHosted: selfHosted.subrequestLimit,
    demo: demo.subrequestLimit,
    disable: null,
  });
  rows.push({
    variable: CACHE_SETTING.minimumSeconds,
    label: "Shortest time an answer stays cached",
    unit: "seconds",
    selfHosted: limitOrOff(selfHosted.cacheFreshness.minimumSeconds),
    demo: limitOrOff(demo.cacheFreshness.minimumSeconds),
    disable: "0",
  });
  const selfHostedQuery = documentLimitsFromBindings(selfHosted.gatewayVariables);
  const demoQuery = documentLimitsFromBindings(demo.gatewayVariables);
  const query = (key: keyof typeof QUERY_LIMIT_SETTING, label: string, unit: string) =>
    rows.push({
      variable: QUERY_LIMIT_SETTING[key],
      label,
      unit,
      selfHosted: limitOrOff(selfHostedQuery[key]),
      demo: limitOrOff(demoQuery[key]),
      disable: "0",
    });
  query("maxDepth", "Query depth", "fields");
  query("maxFields", "Fields per query", "fields");
  query("maxAliases", "Aliases per query", "aliases");
  query("maxTypeExpansions", "Type listings on one path", "listings");
  return rows;
}

/** Every limit a deployment can set: the self-hosted default and the demo's value. */
export const LIMIT_SETTINGS: readonly LimitSetting[] = limitSettingsOf(
  selfHostedSettings("production", {}),
  DEMO_SETTINGS,
);
