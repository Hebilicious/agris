import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import { AdmissionBucket } from "./admission.js";
import type { GatewayEnv, PublicGatewayEnv } from "./env.js";
import { serviceBindingPort } from "./gateway.js";
import privateAgrisProxy from "./index.js";
import { handlePublicGatewayRequest } from "./public-gateway.js";

export type { AssetsPort, MarketAdmissionEnv, PublicGatewayEnv, PublicGatewaySettings, RateLimitPort } from "./env.js";
export type { AdmissionNamespacePort } from "./admission.js";
export { handlePublicGatewayRequest, type PublicGatewayHost } from "./public-gateway.js";

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

/**
 * The exact market admission object: one per client, storing one token bucket, asked only by an execution about to call
 * the market subgraph. A host that sets `MARKET_CLIENT_LIMIT_REQUESTS` binds this class as `ADMISSION`, with a migration
 * that adds it as a new SQLite class: the bucket lives in its synchronous key-value storage, which only SQLite-backed
 * objects have.
 */
export class GatewayAdmission extends DurableObject<PublicGatewayEnv> {
  private readonly bucket = new AdmissionBucket(this.ctx.storage.kv);

  public fetch(request: Request): Promise<Response> {
    return this.bucket.answer(request, Date.now());
  }
}

/**
 * The public gateway: GraphQL over HTTP at `/graphql` (POST, GET and persisted GET by `id`), `/health`, and the
 * `ASSETS` binding, when bound, for everything else. It runs the same validation, budgets, size limits and cached
 * dispatch as the private Service Binding entrypoint, and adds query size limits, optional rate limits and CORS.
 */
export const publicAgrisProxyWorker = {
  fetch(request: Request, env: PublicGatewayEnv, ctx: ExecutionContext): Promise<Response> {
    return handlePublicGatewayRequest(request, env, {
      subgraphs: { MARKET: serviceBindingPort(env.MARKET), CATALOG: serviceBindingPort(env.CATALOG) },
      cached: (syntheticRequest, props) => ctx.exports.CachedAgrisProxy({ props }).fetch(syntheticRequest),
    });
  },
} satisfies ExportedHandler<PublicGatewayEnv>;

export default publicAgrisProxyWorker;
