import * as Cloudflare from "alchemy/Cloudflare";

import type { GatewayAdmission } from "./admission.ts";

/** The public gateway Worker: GraphQL, GraphiQL and `/health` on `workers.dev` and any hostname a stage adds. */
export class AgrisGateway extends Cloudflare.Worker<AgrisGateway, {}>()("AgrisGateway") {}

/** The cache Worker's logical id, which also names its service binding on the gateway. */
export const AGRIS_GATEWAY_CACHE = "AgrisGatewayCache";

/**
 * The gateway's edge-cached execution, which only the gateway reaches.
 *
 * Deployed from its own entrypoint, the gateway enables Workers Cache on one entrypoint and calls it back through
 * `ctx.exports`. An Alchemy Effect Worker serves a single entrypoint and enables the cache for its whole script, so the
 * cached execution is a Worker of its own. Workers Cache answers HTTP requests, so the gateway reaches it with `fetch`,
 * never an RPC method.
 *
 * It also hosts the `GatewayAdmission` objects, which the gateway binds from it.
 */
export class AgrisGatewayCache extends Cloudflare.Worker<AgrisGatewayCache, {}, GatewayAdmission>()(
  AGRIS_GATEWAY_CACHE,
) {}
