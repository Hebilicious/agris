// A host that bundles this module type-checks it without this project's tsconfig; the reference carries the
// `*.graphql` text-module declaration along.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./modules.d.ts" />

import {
  createGatewayRequestProtocol,
  parseFreshnessFloorSeconds,
  PUBLIC_DOCUMENT_LIMITS,
  publicGetBody,
  readBoundedGatewayRequestBody,
  readPersistedOperationDocuments,
  type GatewayProtocolResult,
  type GatewayRequestProtocol,
} from "@agris/core";
import { WorkerEntrypoint } from "cloudflare:workers";
import { renderGraphiQL, shouldRenderGraphiQL } from "graphql-yoga";
import { Predicate } from "effect";

import type { GatewayEnv, PublicGatewayEnv, RateLimitPort } from "./env.js";
import privateAgrisProxy, { clientSchema, gatewayError, serveGatewayOperation, serviceBindingPort } from "./index.js";

import persistedOperationsManifest from "../../../tools/graph/artifacts/persisted-operations.json";

export type { AssetsPort, PublicGatewayEnv, RateLimitPort } from "./env.js";

/**
 * The cache-enabled entrypoint the dispatch reaches through `ctx.exports`, so it must be exported by whichever module
 * is the Worker's main module.
 */
export { CachedAgrisProxy } from "./index.js";

/**
 * The private Service Binding entrypoint, unchanged, for hosts that bind a deployment of this public module: they bind
 * `exportName: "AgrisProxy"` and skip the public surface, its rate limits and its CORS headers.
 */
export class AgrisProxy extends WorkerEntrypoint<GatewayEnv> {
  public fetch(request: Request): Promise<Response> {
    return privateAgrisProxy.fetch(request, this.env, this.ctx);
  }
}

const GRAPHQL_PATH = "/graphql";
const HEALTH_PATH = "/health";
const RETRY_AFTER_SECONDS = 60;
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

const persistedDocuments = readPersistedOperationDocuments(persistedOperationsManifest);
const protocols = new Map<number, GatewayRequestProtocol>();

/**
 * The public gateway: GraphQL over HTTP at `/graphql` (POST, GET and persisted GET by `id`), `/health`, and the
 * `ASSETS` binding, when bound, for everything else. It runs the same validation, budgets, size limits and cached
 * dispatch as the private Service Binding entrypoint, and adds query size limits, optional rate limits and CORS.
 */
export const publicAgrisProxyWorker = {
  async fetch(request: Request, env: PublicGatewayEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const response = await route(request, url, env, ctx);
    return withPublicHeaders(response, env);
  },
} satisfies ExportedHandler<PublicGatewayEnv>;

export default publicAgrisProxyWorker;

async function route(request: Request, url: URL, env: PublicGatewayEnv, ctx: ExecutionContext): Promise<Response> {
  if (url.pathname === GRAPHQL_PATH) return serveGraphql(request, url, env, ctx);
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
  env: PublicGatewayEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed("GET, POST, OPTIONS");

  const limited = await rateLimitRejection(request, env);
  if (limited !== undefined) return limited;

  if (wantsGraphiql(request, env)) return graphiqlPage(url);

  const protocol = publicProtocol(parseFreshnessFloorSeconds(env.MARKET_CACHE_MIN_TTL_SECONDS));
  const normalized =
    request.method === "POST" ? await normalizePost(request, url, protocol) : await normalizeGet(url, protocol);
  if (!normalized.ok) return gatewayError(normalized.error.status, normalized.error.message);
  return serveGatewayOperation(
    normalized.value,
    { MARKET: serviceBindingPort(env.MARKET), CATALOG: serviceBindingPort(env.CATALOG) },
    ctx,
  );
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

/** The client limiter runs first, so one client's flood never spends the deployment-wide allowance. */
async function rateLimitRejection(request: Request, env: PublicGatewayEnv): Promise<Response | undefined> {
  const clientKey = request.headers.get("CF-Connecting-IP") ?? "unknown-client";
  if (!(await admitted(env.CLIENT_RATE_LIMITER, clientKey))) return rateLimited("client", env.DEPLOY_GUIDE_URL);
  if (!(await admitted(env.GLOBAL_RATE_LIMITER, GLOBAL_RATE_LIMIT_KEY)))
    return rateLimited("global", env.DEPLOY_GUIDE_URL);
  return undefined;
}

async function admitted(limiter: RateLimitPort | undefined, key: string): Promise<boolean> {
  if (limiter === undefined) return true;
  const outcome = await limiter.limit({ key });
  return outcome.success;
}

function rateLimited(scope: "client" | "global", deployGuideUrl: string | undefined): Response {
  const deployYourOwn =
    deployGuideUrl === undefined || deployGuideUrl === ""
      ? "deploy your own Agris on Cloudflare"
      : `deploy your own Agris on Cloudflare: ${deployGuideUrl}`;
  const reason = scope === "client" ? "You have sent too many requests" : "This Agris deployment is at capacity";
  return Response.json(
    {
      errors: [
        {
          message: `${reason}. Retry after ${RETRY_AFTER_SECONDS} seconds, or ${deployYourOwn}`,
          extensions: { code: "RATE_LIMITED", scope },
        },
      ],
    },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/graphql-response+json; charset=utf-8",
        "Retry-After": String(RETRY_AFTER_SECONDS),
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function publicProtocol(floorSeconds: number): GatewayRequestProtocol {
  const existing = protocols.get(floorSeconds);
  if (existing !== undefined) return existing;
  const protocol = createGatewayRequestProtocol({
    schema: clientSchema,
    documentLimits: PUBLIC_DOCUMENT_LIMITS,
    acceptExtensions: true,
    freshnessFloorSeconds: floorSeconds,
  });
  protocols.set(floorSeconds, protocol);
  return protocol;
}

/**
 * A browser navigating to `/graphql` gets GraphiQL unless the deployment turned it off. A `?query=` in that URL opens
 * GraphiQL on that query, so a link can share one; API clients, which do not ask for HTML, get the query's result.
 */
function wantsGraphiql(request: Request, env: PublicGatewayEnv): boolean {
  return graphiqlEnabled(env.GRAPHIQL) && shouldRenderGraphiQL(request);
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
const GRAPHIQL_OPTIONS = { title: "Agris GraphiQL", endpoint: GRAPHQL_PATH };
const GRAPHIQL_OPTIONS_WITH_EXAMPLE = { ...GRAPHIQL_OPTIONS, query: GRAPHIQL_DEFAULT_QUERY };

function graphiqlPage(url: URL): Response {
  const html = renderGraphiQL(url.searchParams.has("query") ? GRAPHIQL_OPTIONS : GRAPHIQL_OPTIONS_WITH_EXAMPLE);
  return new Response(html, {
    headers: { "Cache-Control": "public, max-age=3600", "Content-Type": "text/html; charset=utf-8" },
  });
}

function withPublicHeaders(response: Response, env: PublicGatewayEnv): Response {
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
