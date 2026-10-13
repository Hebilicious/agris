import {
  createPublicGatewayRequestProtocol,
  DEFAULT_CACHE_FRESHNESS,
  documentLimitsFromBindings,
  publicGetBody,
  readBoundedGatewayRequestBody,
  readPersistedOperationDocuments,
  type CacheFreshnessPolicy,
  type GatewayDocumentLimits,
  type GatewayProtocolResult,
  type GatewayRequestProtocol,
} from "@agris/core";
import { subrequestLimitFromBinding } from "@agris/invocation-budget";
import { renderGraphiQL, shouldRenderGraphiQL } from "graphql-yoga";
import { Predicate } from "effect";

import {
  ADMISSION_UNAVAILABLE_RETRY_SECONDS,
  admissionLimitsFromBindings,
  admissionObjectName,
  admitThrough,
  clientAdmissionKey,
  type AdmissionDecision,
  type AdmissionNamespacePort,
  type AdmissionRate,
} from "./admission.js";
import type { PublicGatewaySettings, RateLimitPort } from "./env.js";
import { AGRIS_FAVICON_URL } from "./graphiql-favicon.js";
import {
  clientSchema,
  deploymentCacheFreshness,
  gatewayError,
  serveGatewayOperationWith,
  type AgrisProxyRuntimeEnv,
  type CachedAgrisProxyExecution,
} from "./gateway.js";

import persistedOperationsManifest from "../../../tools/schema/artifacts/persisted-operations.json";

/**
 * The public gateway, independent of how a Worker hosts it: `public.ts` serves it as a Worker entrypoint, and the
 * Alchemy gateway under `infra/` serves it too. It imports nothing from the Workers runtime.
 */

const GRAPHQL_PATH = "/graphql";
const HEALTH_PATH = "/health";
/** What a caller refused by a rate-limit binding waits: the binding states no period, and 60 seconds covers both. */
const BINDING_RETRY_AFTER_SECONDS = 60;
const GLOBAL_RATE_LIMIT_KEY = "agris-public-gateway";

const CORS_HEADERS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers":
    "Age, Cf-Cache-Status, Retry-After, X-Agris-Demo, X-Central-Market-Refresh, X-Central-Market-Source",
});

const PREFLIGHT_HEADERS = Object.freeze({
  ...CORS_HEADERS,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "no-store",
});

/** The answer to a preflight admission refused: the same permissions, which the browser must not remember. */
const REFUSED_PREFLIGHT = Object.freeze({
  status: 204,
  headers: { ...PREFLIGHT_HEADERS, "Access-Control-Max-Age": "0" },
});

const persistedDocuments = readPersistedOperationDocuments(persistedOperationsManifest);
const protocols = new WeakMap<CacheFreshnessPolicy, Map<string, GatewayRequestProtocol>>();

/** How a Worker hosts the public gateway: its subgraphs and its edge-cached execution. */
export interface PublicGatewayHost {
  /** The market and catalog subgraphs, as ports the gateway calls with its invocation budgets. */
  readonly subgraphs: Pick<AgrisProxyRuntimeEnv, "MARKET" | "CATALOG">;
  /** Serves a storable operation through the host's edge cache. */
  readonly cached: CachedAgrisProxyExecution;
}

/**
 * Answer one request at the public gateway: GraphQL over HTTP at `/graphql` (POST, GET and persisted GET by `id`),
 * `/health`, and the `ASSETS` binding, when bound, for everything else. It runs the same validation, budgets, size
 * limits and cached dispatch as the private Service Binding entrypoint, and adds query size limits, rate limits and
 * CORS. `env` is the deployment's environment, read for its optional bindings and its `CACHE_*`, `QUERY_*` and
 * `ADMISSION_*` variables.
 *
 * Admission comes before the route, so a health check, a preflight or a page of the site spends the same allowance as
 * a query. A refused preflight is still answered `204`, uncacheable, so the browser sends its real request and can read
 * that request's `429`.
 */
export async function handlePublicGatewayRequest(
  request: Request,
  env: PublicGatewaySettings,
  host: PublicGatewayHost,
): Promise<Response> {
  const url = new URL(request.url);
  const admission = await admit(request, env);
  if (admission.admitted) return withPublicHeaders(await route(request, url, env, host, admission.subrequests), env);
  // A browser cannot read a refused preflight, so it would report a network error. The preflight was still charged;
  // answering it lets the real request through to admission, whose refusal the browser can read, and `Max-Age: 0`
  // keeps the browser from skipping the next preflight.
  if (request.method === "OPTIONS") return withPublicHeaders(new Response(null, REFUSED_PREFLIGHT), env);
  return withPublicHeaders(admission.refusal, env);
}

async function route(
  request: Request,
  url: URL,
  env: PublicGatewaySettings,
  host: PublicGatewayHost,
  admissionSubrequests: number,
) {
  if (url.pathname === GRAPHQL_PATH) return serveGraphql(request, url, env, host, admissionSubrequests);
  if (url.pathname === HEALTH_PATH) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD, OPTIONS");
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  }
  if (env.ASSETS !== undefined) return env.ASSETS.fetch(request);
  return Response.json(
    { errors: [{ message: `Not found. Agris serves GraphQL at ${GRAPHQL_PATH}.` }] },
    { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}

async function serveGraphql(
  request: Request,
  url: URL,
  env: PublicGatewaySettings,
  host: PublicGatewayHost,
  admissionSubrequests: number,
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed("GET, POST, OPTIONS");

  if (wantsGraphiql(request, url, env)) return graphiqlPage(url);

  const protocol = publicProtocol(
    deploymentCacheFreshness(env) ?? DEFAULT_CACHE_FRESHNESS,
    documentLimitsFromBindings(env),
  );
  const normalized =
    request.method === "POST" ? await normalizePost(request, url, protocol) : await normalizeGet(url, protocol);
  if (!normalized.ok) return gatewayError(normalized.error.status, normalized.error.message);
  // The admission calls this invocation made are subrequests too, so an uncached execution spends what is left.
  const subrequestLimit = Math.max(0, subrequestLimitFromBinding(env.SUBREQUEST_LIMIT) - admissionSubrequests);
  const runtime = { ...host.subgraphs, subrequestLimit };
  return serveGatewayOperationWith(normalized.value, runtime, host.cached);
}

async function normalizePost(
  request: Request,
  url: URL,
  protocol: GatewayRequestProtocol,
): Promise<GatewayProtocolResult> {
  const bodyText = await readBoundedGatewayRequestBody(request);
  if (bodyText === undefined) return invalidRequest("GraphQL request body exceeds the accepted size");
  return protocol.normalize({
    method: "POST",
    contentType: request.headers.get("content-type"),
    searchParams: url.search.slice(1),
    bodyText,
  });
}

async function normalizeGet(url: URL, protocol: GatewayRequestProtocol): Promise<GatewayProtocolResult> {
  const body = publicGetBody(url.search.slice(1), persistedDocuments);
  if (!body.ok) return body;
  return protocol.normalize({
    method: "POST",
    contentType: "application/json",
    searchParams: "",
    bodyText: body.bodyText,
  });
}

type Admission =
  | { readonly admitted: true; readonly subrequests: number }
  | { readonly admitted: false; readonly refusal: Response };

/**
 * Admit one request, client scope first, so one client's flood never spends the deployment-wide allowance. In each
 * scope the rate-limit binding, when bound, answers first and costs nothing beyond the invocation; the exact limit,
 * when set, then asks that scope's `GatewayAdmission` object.
 *
 * Admission fails closed: when an object cannot answer, the request is refused with a 503 rather than admitted, since
 * an overloaded object is exactly what a flood causes. Setting an exact limit without binding `ADMISSION` throws.
 */
async function admit(request: Request, env: PublicGatewaySettings): Promise<Admission> {
  const limits = admissionLimitsFromBindings(env);
  const namespace = limits.client === null && limits.global === null ? undefined : admissionNamespace(env.ADMISSION);
  const clientKey = clientAdmissionKey(request.headers.get("CF-Connecting-IP"));
  let subrequests = 0;
  for (const scope of ["client", "global"] as const) {
    const limiter = scope === "client" ? env.CLIENT_RATE_LIMITER : env.GLOBAL_RATE_LIMITER;
    if (!(await bindingAdmits(limiter, scope === "client" ? clientKey : GLOBAL_RATE_LIMIT_KEY))) {
      return { admitted: false, refusal: rateLimited(scope, BINDING_RETRY_AFTER_SECONDS, env.DEPLOY_GUIDE_URL) };
    }
    const rate = limits[scope];
    if (rate === null || namespace === undefined) continue;
    subrequests += 1;
    const decision = await exactDecision(namespace, admissionObjectName(scope, clientKey), rate);
    if (decision === undefined) return { admitted: false, refusal: admissionUnavailable() };
    if (!decision.admitted) {
      return { admitted: false, refusal: rateLimited(scope, decision.retryAfterSeconds, env.DEPLOY_GUIDE_URL) };
    }
  }
  return { admitted: true, subrequests };
}

/** A deployment without the limiter's binding limits nothing here. */
async function bindingAdmits(limiter: RateLimitPort | undefined, key: string): Promise<boolean> {
  if (limiter === undefined) return true;
  const outcome = await limiter.limit({ key });
  return outcome.success;
}

/** One object's decision, or `undefined` when it could not give one. */
async function exactDecision(
  namespace: AdmissionNamespacePort,
  name: string,
  rate: AdmissionRate,
): Promise<AdmissionDecision | undefined> {
  try {
    return await admitThrough(namespace, name, rate);
  } catch (error: unknown) {
    console.error({ event: "gateway-admission-unavailable", name, error: String(error) });
    return undefined;
  }
}

function admissionNamespace(namespace: AdmissionNamespacePort | undefined): AdmissionNamespacePort {
  if (namespace === undefined) {
    throw new TypeError("An ADMISSION_* limit is set, but the gateway binds no ADMISSION Durable Object namespace");
  }
  return namespace;
}

function admissionUnavailable(): Response {
  const retryAfter = ADMISSION_UNAVAILABLE_RETRY_SECONDS;
  return Response.json(
    {
      errors: [
        {
          message: `This Agris deployment cannot admit requests right now. Retry after ${retryAfter} seconds`,
          extensions: { code: "ADMISSION_UNAVAILABLE" },
        },
      ],
    },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/graphql-response+json; charset=utf-8",
        "Retry-After": String(retryAfter),
      },
    },
  );
}

function rateLimited(
  scope: "client" | "global",
  retryAfterSeconds: number,
  deployGuideUrl: string | undefined,
): Response {
  const deployYourOwn =
    deployGuideUrl === undefined || deployGuideUrl === ""
      ? "deploy your own Agris on Cloudflare"
      : `deploy your own Agris on Cloudflare: ${deployGuideUrl}`;
  const reason = scope === "client" ? "You have sent too many requests" : "This Agris deployment is at capacity";
  return Response.json(
    {
      errors: [
        {
          message: `${reason}. Retry after ${retryAfterSeconds} seconds, or ${deployYourOwn}`,
          extensions: { code: "RATE_LIMITED", scope },
        },
      ],
    },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/graphql-response+json; charset=utf-8",
        "Retry-After": String(retryAfterSeconds),
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

/** One protocol per freshness policy and distinct query limits, built on first use. */
function publicProtocol(
  cacheFreshness: CacheFreshnessPolicy,
  documentLimits: GatewayDocumentLimits,
): GatewayRequestProtocol {
  const byLimits = protocols.get(cacheFreshness) ?? new Map<string, GatewayRequestProtocol>();
  protocols.set(cacheFreshness, byLimits);
  // `JSON.stringify` writes a lifted limit (`Infinity`) as `null`, which no other limit value shares.
  const key = JSON.stringify(documentLimits);
  const existing = byLimits.get(key);
  if (existing !== undefined) return existing;
  const protocol = createPublicGatewayRequestProtocol({ schema: clientSchema, cacheFreshness, documentLimits });
  byLimits.set(key, protocol);
  return protocol;
}

/**
 * A browser navigating to `/graphql` gets GraphiQL unless the deployment turned it off: on the bare path, or on a link
 * that carries `?query=`, which GraphiQL opens so a link can share a query. Any other GET, such as a persisted
 * `?id=`, is a request for data and gets its result, as it does for API clients that do not ask for HTML.
 */
function wantsGraphiql(request: Request, url: URL, env: PublicGatewaySettings): boolean {
  if (!graphiqlEnabled(env.GRAPHIQL) || !shouldRenderGraphiQL(request)) return false;
  return url.search === "" || url.searchParams.has("query");
}

/* BOUNDARY: A deployment's `GRAPHIQL` binding: absent or "enabled" serves GraphiQL, "disabled" does not. */
function graphiqlEnabled(value: unknown): boolean {
  if (value === undefined || value === "enabled") return true;
  if (value === "disabled") return false;
  throw new TypeError('GRAPHIQL must be "enabled" or "disabled"');
}

const GRAPHIQL_DEFAULT_QUERY = `# Prices and names for two items on the EU market.
query Prices {
  market(region: EU) {
    observedAt
    items(ids: ["44195", "10006"]) {
      item { id name }
      basePrice
      currentStock
    }
  }
}
`;

// Yoga's GraphiQL page takes its `query` option over the URL's `?query=`, and its own welcome comment when neither is
// set; its `defaultQuery` never reaches the editor. So the example query is passed only when the link carries none.
// `GraphiQLOptions` does not declare `query`, so the options are a named object rather than a literal.
const GRAPHIQL_OPTIONS = { title: "Agris GraphiQL", endpoint: GRAPHQL_PATH, favicon: AGRIS_FAVICON_URL };
const GRAPHIQL_OPTIONS_WITH_EXAMPLE = { ...GRAPHIQL_OPTIONS, query: GRAPHIQL_DEFAULT_QUERY };

/** Yoga's page template links its own icon whatever the `favicon` option says, so the page's icon link is replaced. */
const YOGA_ICON_LINK = /<link rel=icon href=[^>]*>/u;
const AGRIS_ICON_LINK = `<link rel=icon type="image/svg+xml" href="${AGRIS_FAVICON_URL}">`;

function graphiqlPage(url: URL): Response {
  const html = renderGraphiQL(url.searchParams.has("query") ? GRAPHIQL_OPTIONS : GRAPHIQL_OPTIONS_WITH_EXAMPLE).replace(
    YOGA_ICON_LINK,
    AGRIS_ICON_LINK,
  );
  return new Response(html, {
    headers: { "Cache-Control": "public, max-age=3600", "Content-Type": "text/html; charset=utf-8" },
  });
}

function withPublicHeaders(response: Response, env: PublicGatewaySettings): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  const notice = demoNotice(env.DEMO_NOTICE);
  if (notice !== undefined) headers.set("X-Agris-Demo", notice);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/* BOUNDARY: A deployment's binding value; only printable ASCII is a valid header value everywhere. */
function demoNotice(value: unknown): string | undefined {
  return Predicate.isString(value) && /^[\x20-\x7e]+$/u.test(value) ? value : undefined;
}

function methodNotAllowed(allow: string): Response {
  const response = gatewayError(405, `Use one of ${allow}`);
  response.headers.set("Allow", allow);
  return response;
}

function invalidRequest(message: string): GatewayProtocolResult {
  return { ok: false, error: { status: 400, code: "invalid-request", message } };
}
