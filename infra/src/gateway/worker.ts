import { handlePublicGatewayRequest } from "@agris/gateway-worker/public-gateway";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { stageSettings } from "../settings.ts";
import { deployEnvironment, deployProps } from "../stack.ts";
import { admissionNamespace, GatewayAdmission } from "./admission.ts";
import { AGRIS_GATEWAY_CACHE, AgrisGateway, AgrisGatewayCache } from "./contract.ts";
import { withExecutionProps } from "./execution-props.ts";
import { gatewayProps } from "./props.ts";
import { httpServiceBinding } from "./service-binding.ts";
import { bindSubgraphs } from "./subgraphs.ts";

/**
 * The public gateway Worker: `@agris/gateway-worker`'s public gateway hosted by Alchemy.
 *
 * It reads its optional rate limiters and its `CACHE_*`, `QUERY_*`, `MARKET_CLIENT_LIMIT_*` and `GRAPHIQL` variables
 * from its own environment, as its own entrypoint does. A storable operation goes through the cache Worker, whose
 * responses Workers Cache keeps at the edge; everything else executes here, and admits its market calls through the
 * `GatewayAdmission` objects the cache Worker hosts, which it reaches as `ADMISSION`.
 */
export default AgrisGateway.make(
  Stack.useSync(({ stage }) =>
    deployProps(import.meta.url, () => gatewayProps(stageSettings(stage, deployEnvironment()))),
  ),
  Effect.gen(function* () {
    const subgraphs = yield* bindSubgraphs;
    yield* Cloudflare.Workers.bindWorker(AgrisGatewayCache);
    yield* GatewayAdmission.from(AgrisGatewayCache);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Request;
        const env = yield* Cloudflare.Workers.WorkerEnvironment;
        const cache = httpServiceBinding(env, AGRIS_GATEWAY_CACHE);
        const host = {
          subgraphs: yield* subgraphs,
          cached: (syntheticRequest: Request, props: Parameters<typeof withExecutionProps>[1]) =>
            cache.fetch(withExecutionProps(syntheticRequest, props)),
        };
        const settings = { ...env, ADMISSION: admissionNamespace(env) };
        const response = yield* Effect.promise(() => handlePublicGatewayRequest(request, settings, host));
        return HttpServerResponse.fromWeb(response);
      }),
    };
  }),
);
