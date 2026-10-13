import { executeAgrisProxy } from "@agris/gateway-worker/gateway";
import { subrequestLimitFromBinding } from "@agris/invocation-budget";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Predicate from "effect/Predicate";

import { stageSettings } from "../settings.ts";
import { deployEnvironment, deployProps } from "../stack.ts";
import { AgrisGatewayCache } from "./contract.ts";
import { executionPropsOf } from "./execution-props.ts";
import { gatewayCacheProps } from "./props.ts";
import { bindSubgraphs } from "./subgraphs.ts";

/**
 * The gateway's edge-cached execution.
 *
 * Workers Cache answers a repeated cache key before this Worker runs; a miss executes the operation the key request
 * carries, and the response's own `Cache-Control` decides how long the edge keeps it.
 */
export default AgrisGatewayCache.make(
  Stack.useSync(({ stage }) =>
    deployProps(import.meta.url, () => gatewayCacheProps(stageSettings(stage, deployEnvironment()))),
  ),
  Effect.gen(function* () {
    yield* Cloudflare.cache();
    const subgraphs = yield* bindSubgraphs;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Request;
        const props = executionPropsOf(request);
        if (props === null) return HttpServerResponse.text("Missing operation", { status: 400 });
        const env: object = yield* Cloudflare.Workers.WorkerEnvironment;
        const runtime = {
          ...(yield* subgraphs),
          subrequestLimit: subrequestLimitFromBinding(
            Predicate.hasProperty(env, "SUBREQUEST_LIMIT") ? env.SUBREQUEST_LIMIT : undefined,
          ),
        };
        return HttpServerResponse.fromWeb(yield* Effect.promise(() => executeAgrisProxy(runtime, props)));
      }),
    };
  }),
);
