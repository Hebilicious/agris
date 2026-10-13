import type { NormalizedGatewayRequest } from "@agris/core";
import { subrequestLimitFromBinding } from "@agris/invocation-budget";
import { WorkerEntrypoint } from "cloudflare:workers";

import type { GatewayEnv, SmokeGatewayEnv } from "./env.js";
import {
  deploymentCacheFreshness,
  executeAgrisProxy,
  handleAgrisProxyRequest,
  serveGatewayOperationWith,
  serviceBindingPort,
  type AgrisProxyExecutionProps,
  type AgrisProxyRuntimeEnv,
} from "./gateway.js";

export type { GatewayEnv, LocalGatewayEnv, SmokeGatewayEnv } from "./env.js";
export {
  clientSchema,
  deploymentCacheFreshness,
  executeAgrisProxy,
  gatewayError,
  handleAgrisProxyRequest,
  serveGatewayOperationWith,
  serviceBindingPort,
  type AgrisProxyExecutionProps,
  type AgrisProxyRuntimeEnv,
  type BudgetedSubgraphServiceBinding,
  type CachedAgrisProxyExecution,
} from "./gateway.js";
export { gatewayPlugins } from "./plugins.js";

type DeployedAgrisProxyEnv = GatewayEnv | SmokeGatewayEnv;

/** The cache-enabled entrypoint: Workers Cache answers a repeated operation before it runs. */
export class CachedAgrisProxy extends WorkerEntrypoint<DeployedAgrisProxyEnv, AgrisProxyExecutionProps> {
  public async fetch(_request: Request): Promise<Response> {
    return executeAgrisProxy(deployedRuntime(this.env), this.ctx.props);
  }
}

export const agrisProxyWorker = {
  fetch(request: Request, env: AgrisProxyRuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    return handleAgrisProxyRequest(request, env, (syntheticRequest, props) =>
      ctx.exports.CachedAgrisProxy({ props }).fetch(syntheticRequest),
    );
  },
} satisfies ExportedHandler<AgrisProxyRuntimeEnv>;

/**
 * Serve one normalized operation: through the cache-enabled `CachedAgrisProxy` entrypoint when its policy stores it,
 * otherwise directly. The main module of the Worker that calls this must export `CachedAgrisProxy`.
 */
export function serveGatewayOperation(
  normalized: NormalizedGatewayRequest,
  env: AgrisProxyRuntimeEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  return serveGatewayOperationWith(normalized, env, (syntheticRequest, props) =>
    ctx.exports.CachedAgrisProxy({ props }).fetch(syntheticRequest),
  );
}

export default {
  fetch(request: Request, env: DeployedAgrisProxyEnv, ctx: ExecutionContext): Promise<Response> {
    const cacheFreshness = deploymentCacheFreshness(env);
    const runtime = deployedRuntime(env);
    return agrisProxyWorker.fetch(
      request,
      cacheFreshness === undefined ? runtime : { ...runtime, cacheFreshness },
      ctx,
    );
  },
} satisfies ExportedHandler<DeployedAgrisProxyEnv>;

function deployedRuntime(env: DeployedAgrisProxyEnv): AgrisProxyRuntimeEnv {
  return {
    MARKET: serviceBindingPort(env.MARKET),
    CATALOG: serviceBindingPort(env.CATALOG),
    subrequestLimit: subrequestLimitFromBinding(env.SUBREQUEST_LIMIT),
    ...("CACHE_SMOKE_MODE" in env ? { CACHE_SMOKE_MODE: env.CACHE_SMOKE_MODE } : undefined),
  };
}
