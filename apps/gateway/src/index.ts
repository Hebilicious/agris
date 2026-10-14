import type { NormalizedGatewayRequest } from "@agris/core";
import { subrequestLimitFromBinding } from "@agris/invocation-budget";
import { WorkerEntrypoint } from "cloudflare:workers";

import { clientAdmissionKeyOf, marketAdmissionFromBindings } from "./admission.js";
import type { GatewayEnv, MarketAdmissionEnv, SmokeGatewayEnv } from "./env.js";
import {
  deploymentCacheFreshness,
  executeAgrisProxy,
  handleAgrisProxyRequest,
  serveGatewayOperationWith,
  serviceBindingPort,
  type AgrisProxyExecutionProps,
  type AgrisProxyRuntimeEnv,
} from "./gateway.js";

export type { GatewayEnv, LocalGatewayEnv, MarketAdmissionEnv, SmokeGatewayEnv } from "./env.js";
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

type DeployedAgrisProxyEnv = (GatewayEnv | SmokeGatewayEnv) & MarketAdmissionEnv;

/**
 * The cache-enabled entrypoint: Workers Cache answers a repeated operation before it runs. On a miss for a public
 * caller, whose client key the cache key request carries in a header (Workers Cache keys on the props, not on it), the
 * execution admits its market calls through the Worker's `GatewayAdmission` buckets when `MARKET_CLIENT_LIMIT_*` is
 * set.
 */
export class CachedAgrisProxy extends WorkerEntrypoint<DeployedAgrisProxyEnv, AgrisProxyExecutionProps> {
  public async fetch(request: Request): Promise<Response> {
    return executeCachedAgrisProxy(this.env, this.ctx.props, request);
  }
}

/** What `CachedAgrisProxy` runs on a cache miss: `props`, admitted under the client key `cacheKey` carries. */
export function executeCachedAgrisProxy(
  env: DeployedAgrisProxyEnv,
  props: AgrisProxyExecutionProps,
  cacheKey: Request,
): Promise<Response> {
  const runtime = { ...deployedRuntime(env), ...marketAdmissionOf(env) };
  return executeAgrisProxy(runtime, props, clientAdmissionKeyOf(cacheKey));
}

/** The market admission a deployment's bindings set, as runtime fields; none when it sets no exact limit. */
function marketAdmissionOf(env: MarketAdmissionEnv): Pick<AgrisProxyRuntimeEnv, "marketAdmission"> {
  const marketAdmission = marketAdmissionFromBindings(env, env.ADMISSION);
  return marketAdmission === undefined ? {} : { marketAdmission };
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
    ...(env.CACHE_SMOKE_MODE === "enabled" ? { CACHE_SMOKE_MODE: "enabled" } : undefined),
  };
}
