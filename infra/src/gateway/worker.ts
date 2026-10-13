import { AdmissionBucket, type AdmissionNamespacePort } from "@agris/gateway-worker/admission";
import { handlePublicGatewayRequest } from "@agris/gateway-worker/public-gateway";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Predicate from "effect/Predicate";

import { stageSettings } from "../settings.ts";
import { deployEnvironment, deployProps } from "../stack.ts";
import { AGRIS_GATEWAY_CACHE, AgrisGateway, AgrisGatewayCache } from "./contract.ts";
import { withExecutionProps } from "./execution-props.ts";
import { gatewayProps } from "./props.ts";
import { httpServiceBinding } from "./service-binding.ts";
import { bindSubgraphs } from "./subgraphs.ts";

/** The admission object's logical id, which also names its namespace binding on the gateway Worker. */
const GATEWAY_ADMISSION = "GatewayAdmission";

/**
 * The gateway's exact admission: one object per client and one for the whole deployment, each storing one token bucket
 * (`AdmissionBucket`) in its SQLite-backed storage, which Alchemy gives every new Durable Object class. The gateway asks
 * it before every request when the stage sets `ADMISSION_*` limits.
 */
export class GatewayAdmission extends Cloudflare.DurableObject<GatewayAdmission>()(
  GATEWAY_ADMISSION,
  // The outer effect runs once per class; the inner one once per object, so each object keeps its own bucket.
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* Cloudflare.Workers.DurableObjectState;
      const bucket = new AdmissionBucket(state.raw.storage.kv);
      return {
        fetch: Effect.gen(function* () {
          const request = nativeRequest(yield* HttpServerRequest);
          return HttpServerResponse.fromWeb(yield* Effect.promise(() => bucket.answer(request, Date.now())));
        }),
      };
    }),
  ),
) {}

/**
 * The public gateway Worker: `@agris/gateway-worker`'s public gateway hosted by Alchemy.
 *
 * It reads its optional rate limiters and its `CACHE_*`, `QUERY_*`, `ADMISSION_*` and `GRAPHIQL` variables from its own
 * environment, as its own entrypoint does, and reaches its `GatewayAdmission` objects as `ADMISSION`. A storable
 * operation goes through the cache Worker, whose responses Workers Cache keeps at the edge; everything else executes
 * here.
 */
export default AgrisGateway.make(
  Stack.useSync(({ stage }) =>
    deployProps(import.meta.url, () => gatewayProps(stageSettings(stage, deployEnvironment()))),
  ),
  Effect.gen(function* () {
    yield* GatewayAdmission;
    const subgraphs = yield* bindSubgraphs;
    yield* Cloudflare.Workers.bindWorker(AgrisGatewayCache);
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

/* BOUNDARY: The Durable Object's request wraps the native Request it was called with; it is checked to be one. */
function nativeRequest(request: HttpServerRequest): Request {
  if (!(request.source instanceof Request))
    throw new TypeError("GatewayAdmission was called without a native Request.");
  return request.source;
}

/**
 * The admission objects' native namespace binding, which `yield* GatewayAdmission` declared under its logical id. The
 * gateway calls each object's `fetch` on the native stub, as the market calls its coordinators.
 */
/* BOUNDARY: The Worker environment is untyped; the binding is checked to be a namespace before it is called. */
function admissionNamespace(env: object): AdmissionNamespacePort {
  const binding: unknown = Predicate.hasProperty(env, GATEWAY_ADMISSION) ? env[GATEWAY_ADMISSION] : undefined;
  if (!Predicate.hasProperty(binding, "getByName") || !Predicate.isFunction(binding.getByName)) {
    throw new TypeError(`The gateway Worker has no ${GATEWAY_ADMISSION} namespace binding.`);
  }
  const getByName = binding.getByName;
  return {
    getByName: (name) => {
      const stub: unknown = getByName.call(binding, name);
      if (!Predicate.hasProperty(stub, "fetch") || !Predicate.isFunction(stub.fetch)) {
        throw new TypeError(`The ${GATEWAY_ADMISSION} namespace returned no fetchable stub.`);
      }
      const fetch = stub.fetch;
      return { fetch: (admissionRequest) => fetch.call(stub, admissionRequest) };
    },
  };
}
