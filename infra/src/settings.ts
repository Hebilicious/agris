/**
 * What each stage deploys: the Workers' names, their rate limits, the Pearl Abyss limits, and the plain-text variables
 * the gateway binds. The stack (`alchemy.run.ts`) deploys these, and the website states them, so the site can never
 * describe a limit the deployment does not have.
 *
 * - `demo` is the maintainer's shared, heavily limited instance; its figures are fixed here.
 * - `docs` deploys the static site alone and has no settings.
 * - Every other stage is a self-hosted deployment, configured from the environment of the deploy command: unset
 *   variables keep `SELF_HOSTED_DEFAULTS`, and `0` turns a limit off.
 *
 * This module imports nothing from Alchemy or the Workers runtime, so the site and the tests read it as plain data.
 */
// By subpath rather than the package index, so Node loads this module as it is: the bundler and the site run it
// without a TypeScript loader, and the index reaches modules by `.js` paths that only a loader maps to `.ts`.
import {
  CACHE_SETTING_NAMES,
  cacheFreshnessFromBindings,
  cacheFreshnessOverrideFromBindings,
  cacheSettingsOf,
  type CacheFreshnessOverride,
  type CacheFreshnessPolicy,
} from "@agris/core/cache-freshness";
import { documentLimitsFromBindings, QUERY_LIMIT_SETTING } from "@agris/core/document-limits";
import { MARKET_ADMISSION_SETTING } from "@agris/gateway-worker/admission";
import { DEFAULT_SUBREQUEST_LIMIT } from "@agris/invocation-budget/subrequest-limit";
import { Exit, Schema, SchemaTransformation } from "effect";
import { buildSchema } from "graphql";

import { clientSchemaSdl } from "../../tools/schema/artifacts/gateway-schemas.ts";

const clientSchema = buildSchema(clientSchemaSdl);

/** A Workers rate limit: `limit` requests per `period` seconds, counted per Cloudflare location. */
export interface Rate {
  readonly limit: number;
  readonly period: 10 | 60;
}

/** A rate limit as a Worker binds it: its rate, and the account-scoped namespace that keeps its counters. */
export interface RateLimitSetting extends Rate {
  readonly namespaceId: string;
}

/** An exact limit a Durable Object keeps: `limit` requests in any `periodSeconds`, any whole number of seconds. */
export interface ExactRate {
  readonly limit: number;
  readonly periodSeconds: number;
}

/** The names of the Workers one stage deploys. */
export interface WorkerNames {
  /** The public gateway: GraphQL, GraphiQL and `/health`. */
  readonly gateway: string;
  /** The gateway's edge-cached execution, which only the gateway reaches. */
  readonly cache: string;
  readonly market: string;
  readonly catalog: string;
}

/** Everything one API stage deploys. */
export interface DeploymentSettings {
  readonly names: WorkerNames;
  /**
   * `CLIENT_RATE_LIMITER` on the gateway, per client IP (an IPv6 address by its /64), on every request; `null` binds
   * none and limits no client there. Counted per Cloudflare location, with no round trip.
   */
  readonly clientRateLimit: RateLimitSetting | null;
  /** `GLOBAL_RATE_LIMITER` on the gateway, for the whole deployment, per location; `null` binds none. */
  readonly globalRateLimit: RateLimitSetting | null;
  /**
   * The exact market admission (`MARKET_CLIENT_LIMIT_*` on the gateway and the cache Worker): per client, kept by a
   * `GatewayAdmission` Durable Object, and asked only by an execution about to call the market subgraph. `null` sets
   * none.
   */
  readonly marketClientLimit: ExactRate | null;
  /**
   * `PA_RATE_LIMITER` on the market Worker, the burst backstop on Pearl Abyss calls for the whole deployment: one
   * coordinator consults it for every host, from one location. `null` binds none.
   */
  readonly pearlAbyssRateLimit: RateLimitSetting | null;
  /** `PA_MAX_CONCURRENT_REQUESTS`: distinct Pearl Abyss requests at once, per host; `0` sets no limit of its own. */
  readonly pearlAbyssConcurrency: number;
  /**
   * `SUBREQUEST_LIMIT`: each Worker's `limits.subrequests`, and the budget one request's execution spends within it.
   * The default is 50.
   */
  readonly subrequestLimit: number;
  /** The cache settings among `gatewayVariables`, as a change to the default policy; `null` when there are none. */
  readonly cacheOverride: CacheFreshnessOverride | null;
  /** The cache freshness the gateway runs with. */
  readonly cacheFreshness: CacheFreshnessPolicy;
  /**
   * Plain-text variables the gateway binds: `CACHE_*`, `QUERY_*`, `MARKET_CLIENT_LIMIT_*`, `GRAPHIQL`, `DEMO_NOTICE`,
   * `DEPLOY_GUIDE_URL`.
   */
  readonly gatewayVariables: Readonly<Record<string, string>>;
  /** A hostname on a zone in the account that serves the gateway, besides `workers.dev`; `null` for none. */
  readonly domain: string | null;
  /** Whether the gateway answers at its `workers.dev` address. */
  readonly workersDev: boolean;
  /** The share of invocations whose logs and traces are kept. */
  readonly sampling: { readonly logs: number; readonly traces: number };
}

/** The stage that deploys the shared demo. */
export const DEMO_STAGE = "demo";
/** The stage that deploys the static docs site. */
export const DOCS_STAGE = "docs";
/** The stage `moon run infra:deploy` deploys when no other is named; its Workers take the plain `agris` names. */
export const DEFAULT_STAGE = "production";

/** The docs site's Worker: static assets only, no code. */
export const DOCS_WORKER_NAME = "agris-docs";

/** Where the demo, its rate-limit errors and the docs send a reader who should deploy their own. */
export const DEPLOY_GUIDE_URL = "https://agris-docs.hebilicious.workers.dev/#deploy";

/** The names a stage's Workers take: `agris`, `agris-market`… for `production`, `agris-<stage>-market`… otherwise. */
export function workerNames(stage: string): WorkerNames {
  const base = stage === DEFAULT_STAGE ? "agris" : `agris-${stage}`;
  return { gateway: base, cache: `${base}-cache`, market: `${base}-market`, catalog: `${base}-catalog` };
}

/** The demo's cache change: every storable answer keeps for at least ten minutes. */
const DEMO_CACHE_OVERRIDE: CacheFreshnessOverride = { minimumSeconds: 600 };

/**
 * The exact market admission's variables, which the gateway and the cache Worker both bind, since both run executions;
 * none when the stage sets no exact limit, and the executions then ask no `GatewayAdmission` object.
 */
export function marketAdmissionVariables(rate: ExactRate | null): Readonly<Record<string, string>> {
  if (rate === null) return {};
  return {
    [MARKET_ADMISSION_SETTING.requests]: String(rate.limit),
    [MARKET_ADMISSION_SETTING.period]: String(rate.periodSeconds),
  };
}

const DEMO_MARKET_CLIENT_LIMIT: ExactRate = { limit: 10, periodSeconds: 60 };

/**
 * The shared demo protects Pearl Abyss first: ten requests a minute per visitor and 120 for everyone at each Cloudflare
 * location, ten market executions a minute per visitor counted exactly, two Pearl Abyss calls at a time per host and
 * twenty a minute in all, a ten-minute cache floor, and sparse telemetry.
 */
export const DEMO_SETTINGS: DeploymentSettings = Object.freeze<DeploymentSettings>({
  names: workerNames(DEMO_STAGE),
  clientRateLimit: { limit: 10, period: 60, namespaceId: "42021" },
  globalRateLimit: { limit: 120, period: 60, namespaceId: "42022" },
  marketClientLimit: DEMO_MARKET_CLIENT_LIMIT,
  pearlAbyssRateLimit: { limit: 20, period: 60, namespaceId: "42020" },
  pearlAbyssConcurrency: 2,
  subrequestLimit: DEFAULT_SUBREQUEST_LIMIT,
  cacheOverride: DEMO_CACHE_OVERRIDE,
  cacheFreshness: cacheFreshnessFromBindings(cacheSettingsOf(DEMO_CACHE_OVERRIDE), clientSchema),
  gatewayVariables: {
    ...cacheSettingsOf(DEMO_CACHE_OVERRIDE),
    ...marketAdmissionVariables(DEMO_MARKET_CLIENT_LIMIT),
    GRAPHIQL: "enabled",
    DEMO_NOTICE: `Shared demo, rate-limited. Deploy your own: ${DEPLOY_GUIDE_URL}`,
    DEPLOY_GUIDE_URL,
  },
  domain: null,
  workersDev: true,
  sampling: { logs: 0.05, traces: 0.01 },
});

/**
 * A self-hosted deployment with nothing set has no limit on clients, whether one at a time or all together, six Pearl
 * Abyss calls at a time per host with a burst backstop of a hundred per ten seconds in all, fifty subrequests per
 * invocation, and the default cache. The Pearl Abyss limits protect the upstream whoever is asking, so a client limit
 * is the deployer's choice: set `CLIENT_RATE_LIMIT_REQUESTS` to turn one on, and `MARKET_CLIENT_LIMIT_REQUESTS` for an
 * exact limit on each client's market executions.
 */
export const SELF_HOSTED_DEFAULTS = Object.freeze({
  clientRateLimit: { limit: 0, period: 60, namespaceId: "42010" },
  globalRateLimit: { limit: 0, period: 60, namespaceId: "42011" },
  marketClientLimit: { limit: 0, periodSeconds: 60 },
  pearlAbyssRateLimit: { limit: 100, period: 10, namespaceId: "42003" },
  pearlAbyssConcurrency: 6,
  subrequestLimit: DEFAULT_SUBREQUEST_LIMIT,
  sampling: { logs: 1, traces: 0.05 },
} as const);

/**
 * The deploy-time variables of a self-hosted stage, beside the gateway's own `CACHE_*` and `QUERY_*` variables, which
 * pass through to the gateway, and `GRAPHIQL` and `DEPLOY_GUIDE_URL`, which do too.
 */
export const DEPLOY_SETTING = Object.freeze({
  clientRateLimitRequests: "CLIENT_RATE_LIMIT_REQUESTS",
  clientRateLimitPeriod: "CLIENT_RATE_LIMIT_PERIOD_SECONDS",
  clientRateLimitNamespace: "CLIENT_RATE_LIMIT_NAMESPACE_ID",
  globalRateLimitRequests: "GLOBAL_RATE_LIMIT_REQUESTS",
  globalRateLimitPeriod: "GLOBAL_RATE_LIMIT_PERIOD_SECONDS",
  globalRateLimitNamespace: "GLOBAL_RATE_LIMIT_NAMESPACE_ID",
  marketClientLimitRequests: MARKET_ADMISSION_SETTING.requests,
  marketClientLimitPeriod: MARKET_ADMISSION_SETTING.period,
  pearlAbyssRateLimitRequests: "PA_RATE_LIMIT_REQUESTS",
  pearlAbyssRateLimitPeriod: "PA_RATE_LIMIT_PERIOD_SECONDS",
  pearlAbyssRateLimitNamespace: "PA_RATE_LIMIT_NAMESPACE_ID",
  pearlAbyssConcurrency: "PA_MAX_CONCURRENT_REQUESTS",
  subrequestLimit: "SUBREQUEST_LIMIT",
  domain: "AGRIS_DOMAIN",
  workersDev: "AGRIS_WORKERS_DEV",
});

/** Gateway variables a self-hosted deploy passes through as they are; the gateway validates them, and so does this. */
const PASSED_THROUGH: ReadonlySet<string> = new Set([
  ...CACHE_SETTING_NAMES,
  ...Object.values(QUERY_LIMIT_SETTING),
  "GRAPHIQL",
  "DEPLOY_GUIDE_URL",
]);

/** Prefixes of the variables this module owns: one that starts so but is no setting is a typo, and is refused. */
const OWNED_PREFIXES = [
  "CACHE_",
  "QUERY_",
  "CLIENT_RATE_LIMIT",
  "GLOBAL_RATE_LIMIT",
  "PA_RATE_LIMIT",
  "PA_MAX_",
  "SUBREQUEST_",
  "AGRIS_",
  "MARKET_CLIENT_LIMIT",
];
const KNOWN_DEPLOY_SETTINGS: ReadonlySet<string> = new Set([...Object.values(DEPLOY_SETTING), ...PASSED_THROUGH]);
/** Variables with an owned prefix that belong to the tools around a deploy, not to Agris's settings. */
const FOREIGN_VARIABLES: ReadonlySet<string> = new Set(["CACHE_SMOKE_MODE"]);

const WholeNumber = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u)).pipe(
  Schema.decodeTo(Schema.Int, SchemaTransformation.numberFromString),
);
const SubrequestLimit = WholeNumber.check(Schema.isGreaterThanOrEqualTo(1));
const PositiveSeconds = WholeNumber.check(Schema.isGreaterThanOrEqualTo(1));
const Period = Schema.Literals(["10", "60"]);
const NamespaceId = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u));
const Switch = Schema.Literals(["true", "false"]);
const Hostname = Schema.String.check(
  Schema.isPattern(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u),
);

/**
 * BOUNDARY: A self-hosted stage's settings, read from the deploy command's environment. Every unset variable keeps its
 * default. A rate limit of `0` requests binds no limiter, and a concurrency of `0` sets no limit. It throws a
 * `TypeError` naming every variable it cannot use, including one with an owned prefix that is no setting.
 */
export function selfHostedSettings(
  stage: string,
  environment: Readonly<Record<string, string | undefined>>,
): DeploymentSettings {
  const problems: string[] = [];
  const read = <A>(name: string, schema: Schema.Codec<A, string>, expected: string): A | undefined => {
    const value = environment[name];
    if (value === undefined) return undefined;
    const decoded = Schema.decodeUnknownExit(schema)(value);
    if (Exit.isSuccess(decoded)) return decoded.value;
    problems.push(`${name} must be ${expected}`);
    return undefined;
  };

  for (const name of Object.keys(environment)) {
    if (!OWNED_PREFIXES.some((prefix) => name.startsWith(prefix)) || FOREIGN_VARIABLES.has(name)) continue;
    if (!KNOWN_DEPLOY_SETTINGS.has(name)) problems.push(`${name} is not an Agris setting`);
  }

  const rate = (
    requests: string,
    period: string,
    namespace: string,
    defaults: RateLimitSetting & { readonly limit: number },
  ): RateLimitSetting | null => {
    const limit = read(requests, WholeNumber, "a whole number of requests, 0 for no limit") ?? defaults.limit;
    const periodSeconds = read(period, Period, '"10" or "60" seconds');
    const namespaceId = read(namespace, NamespaceId, "a positive whole number") ?? defaults.namespaceId;
    if (limit === 0) return null;
    return {
      limit,
      period: periodSeconds === undefined ? defaults.period : periodSeconds === "10" ? 10 : 60,
      namespaceId,
    };
  };

  const clientRateLimit = rate(
    DEPLOY_SETTING.clientRateLimitRequests,
    DEPLOY_SETTING.clientRateLimitPeriod,
    DEPLOY_SETTING.clientRateLimitNamespace,
    SELF_HOSTED_DEFAULTS.clientRateLimit,
  );
  const globalRateLimit = rate(
    DEPLOY_SETTING.globalRateLimitRequests,
    DEPLOY_SETTING.globalRateLimitPeriod,
    DEPLOY_SETTING.globalRateLimitNamespace,
    SELF_HOSTED_DEFAULTS.globalRateLimit,
  );
  const pearlAbyssRateLimit = rate(
    DEPLOY_SETTING.pearlAbyssRateLimitRequests,
    DEPLOY_SETTING.pearlAbyssRateLimitPeriod,
    DEPLOY_SETTING.pearlAbyssRateLimitNamespace,
    SELF_HOSTED_DEFAULTS.pearlAbyssRateLimit,
  );
  const marketClientLimitRequests =
    read(DEPLOY_SETTING.marketClientLimitRequests, WholeNumber, "a whole number of requests, 0 for no limit") ??
    SELF_HOSTED_DEFAULTS.marketClientLimit.limit;
  const marketClientLimitPeriod =
    read(DEPLOY_SETTING.marketClientLimitPeriod, PositiveSeconds, "a positive whole number of seconds") ??
    SELF_HOSTED_DEFAULTS.marketClientLimit.periodSeconds;
  const marketClientLimit: ExactRate | null =
    marketClientLimitRequests === 0
      ? null
      : { limit: marketClientLimitRequests, periodSeconds: marketClientLimitPeriod };
  const pearlAbyssConcurrency =
    read(DEPLOY_SETTING.pearlAbyssConcurrency, WholeNumber, "a whole number, 0 for no limit") ??
    SELF_HOSTED_DEFAULTS.pearlAbyssConcurrency;
  const subrequestLimit =
    read(DEPLOY_SETTING.subrequestLimit, SubrequestLimit, "a positive whole number") ??
    SELF_HOSTED_DEFAULTS.subrequestLimit;
  const domain = read(DEPLOY_SETTING.domain, Hostname, "a hostname such as agris.example.com") ?? null;
  const workersDev = read(DEPLOY_SETTING.workersDev, Switch, '"true" or "false"') ?? "true";

  const gatewayVariables: Record<string, string> = { ...marketAdmissionVariables(marketClientLimit) };
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && PASSED_THROUGH.has(name)) gatewayVariables[name] = value;
  }
  let cacheOverride: CacheFreshnessOverride | null = null;
  try {
    cacheOverride = cacheFreshnessOverrideFromBindings(gatewayVariables, clientSchema) ?? null;
  } catch (error: unknown) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  try {
    documentLimitsFromBindings(gatewayVariables);
  } catch (error: unknown) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const graphiql = gatewayVariables.GRAPHIQL;
  if (graphiql !== undefined && graphiql !== "enabled" && graphiql !== "disabled") {
    problems.push('GRAPHIQL must be "enabled" or "disabled"');
  }

  if (problems.length > 0) throw new TypeError(`The ${stage} stage's settings are invalid: ${problems.join("; ")}`);
  return Object.freeze({
    names: workerNames(stage),
    clientRateLimit,
    globalRateLimit,
    marketClientLimit,
    pearlAbyssRateLimit,
    pearlAbyssConcurrency,
    subrequestLimit,
    cacheOverride,
    cacheFreshness: cacheFreshnessFromBindings(gatewayVariables, clientSchema),
    gatewayVariables: Object.freeze(gatewayVariables),
    domain,
    workersDev: workersDev === "true",
    sampling: SELF_HOSTED_DEFAULTS.sampling,
  });
}

/** The settings an API stage deploys: the demo's, or a self-hosted stage's from `environment`. */
export function stageSettings(
  stage: string,
  environment: Readonly<Record<string, string | undefined>>,
): DeploymentSettings {
  if (stage === DOCS_STAGE) throw new TypeError(`The ${DOCS_STAGE} stage deploys only the static site.`);
  return stage === DEMO_STAGE ? DEMO_SETTINGS : selfHostedSettings(stage, environment);
}
