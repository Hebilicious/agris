import type { NormalizedGatewayRequest } from "./types.js";

export interface GatewayOperationDispatchPort {
  readonly cached: (request: Request, execute: () => Promise<Response>) => Promise<Response>;
  readonly execute: (request: NormalizedGatewayRequest) => Promise<Response>;
}

/**
 * Owns the production gateway's cacheable-versus-uncached dispatch decision.
 * The cached port is implemented by Cloudflare's cache-enabled named entrypoint;
 * tests provide an in-memory entrypoint with the same response-storage contract.
 */
export function dispatchGatewayOperation(
  request: NormalizedGatewayRequest,
  port: GatewayOperationDispatchPort,
): Promise<Response> {
  const execute = (): Promise<Response> => port.execute(request);
  return request.cachePolicy.mode === "store"
    ? port.cached(new Request(request.syntheticGetKey, { method: "GET" }), execute)
    : execute();
}
