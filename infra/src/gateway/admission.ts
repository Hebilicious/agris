import { AdmissionBucket, type AdmissionNamespacePort } from "@agris/gateway-worker/admission";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Predicate from "effect/Predicate";

/** The admission object's logical id, which also names its namespace binding on every Worker that binds it. */
export const GATEWAY_ADMISSION = "GatewayAdmission";

/**
 * The exact market admission: one object per client, each storing one token bucket (`AdmissionBucket`) in its
 * SQLite-backed storage, which Alchemy gives every new Durable Object class. An execution asks it once, before its
 * first market subgraph call, when the stage sets `MARKET_CLIENT_LIMIT_REQUESTS`.
 *
 * The cache Worker hosts the class, since it runs most executions; the gateway, which runs the uncacheable ones, binds
 * it from there. The gateway already binds the cache Worker, so hosting the class on the gateway would make each Worker
 * depend on the other.
 */
export class GatewayAdmission extends Cloudflare.DurableObject<GatewayAdmission, GatewayAdmissionShape>()(
  GATEWAY_ADMISSION,
) {}

/** What a `GatewayAdmission` object answers: one admission request at a time, over `fetch`. */
interface GatewayAdmissionShape {
  readonly fetch: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest>;
}

/** The admission objects' implementation, which the hosting Worker provides. */
export const GatewayAdmissionLive = GatewayAdmission.make(
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
);

/* BOUNDARY: The Durable Object's request wraps the native Request it was called with; it is checked to be one. */
function nativeRequest(request: HttpServerRequest): Request {
  if (!(request.source instanceof Request))
    throw new TypeError("GatewayAdmission was called without a native Request.");
  return request.source;
}

/**
 * The admission objects' native namespace binding, which `yield* GatewayAdmission` (or `.from` its host) declared under
 * its logical id. An execution calls each object's `fetch` on the native stub, as the market calls its coordinators.
 */
/* BOUNDARY: The Worker environment is untyped; the binding is checked to be a namespace before it is called. */
export function admissionNamespace(env: object): AdmissionNamespacePort {
  const binding: unknown = Predicate.hasProperty(env, GATEWAY_ADMISSION) ? env[GATEWAY_ADMISSION] : undefined;
  if (!Predicate.hasProperty(binding, "getByName") || !Predicate.isFunction(binding.getByName)) {
    throw new TypeError(`The Worker has no ${GATEWAY_ADMISSION} namespace binding.`);
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
