import { createCatalogSubgraph } from "@agris/catalog-subgraph";
import type { ServiceBindingPort } from "@agris/core";
import { subrequestLimitFromBinding } from "@agris/invocation-budget";
import { WorkerEntrypoint } from "cloudflare:workers";

import type { LocalGatewayEnv } from "./env.js";

import {
  deploymentCacheFreshness,
  executeAgrisProxy,
  agrisProxyWorker,
  serviceBindingPort,
  type AgrisProxyExecutionProps,
  type AgrisProxyRuntimeEnv,
} from "./index.js";

const catalogSubgraph = createCatalogSubgraph();
const catalog: ServiceBindingPort = {
  fetch: async (request) => {
    const response = await catalogSubgraph.fetch(request);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
};

export class CachedAgrisProxy extends WorkerEntrypoint<LocalGatewayEnv, AgrisProxyExecutionProps> {
  public fetch(_request: Request): Promise<Response> {
    return executeAgrisProxy(localRuntime(this.env), this.ctx.props);
  }
}

export default {
  fetch(request: Request, env: LocalGatewayEnv, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/_internal/ready") {
      return Promise.resolve(new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }));
    }
    return agrisProxyWorker.fetch(request, localRuntime(env), ctx);
  },
} satisfies ExportedHandler<LocalGatewayEnv>;

/** The deployed gateway's runtime, with the catalog served inline: the same subrequest budget and cache settings. */
function localRuntime(env: LocalGatewayEnv): AgrisProxyRuntimeEnv {
  const cacheFreshness = deploymentCacheFreshness(env);
  return {
    MARKET: serviceBindingPort(env.MARKET),
    CATALOG: catalog,
    LOCAL_INLINE_CATALOG: true,
    subrequestLimit: subrequestLimitFromBinding(env.SUBREQUEST_LIMIT),
    ...(cacheFreshness === undefined ? undefined : { cacheFreshness }),
  };
}
