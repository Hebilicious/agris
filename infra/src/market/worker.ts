import type { InvocationBudgetReservation, MarketSummaryReservation } from "@agris/invocation-budget";
import {
  executeMarketSubgraph,
  maximumConcurrentRequestsFromBinding,
  PearlAbyssCoordination,
  pearlAbyssCoordinatorAddress,
  readinessResponse,
  standaloneBudget,
  type PearlAbyssCoordinatorPort,
  type PearlAbyssRateLimiter,
} from "@agris/market-worker/market";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { stageSettings } from "../settings.ts";
import { deployEnvironment, deployProps } from "../stack.ts";
import { AgrisMarket } from "./contract.ts";
import { marketProps } from "./props.ts";

/** The coordinator's logical id, which also names its namespace binding on the market Worker. */
const PEARL_ABYSS_COORDINATOR = "PearlAbyssCoordinator";

/**
 * One coordinator per Pearl Abyss host, which admits each distinct upstream request once. The market creates each one
 * with the location hint its name carries (`pearlAbyssCoordinatorAddress`), so its calls start next to the Pearl Abyss
 * server that answers them.
 *
 * It answers `fetch`, and the stack's `enable_request_signal` flag (`compatibility()` in `stack.ts`) makes each
 * request's signal abort when its caller goes away: that caller stops its own wait, and the request leaves the queue,
 * or its upstream call is cancelled, once every caller sharing it has given up. Whether or not anyone is still
 * waiting, each distinct request has `PEARL_ABYSS_REQUEST_TIMEOUT_MS` from its arrival before the coordinator drops it,
 * and each permit `PEARL_ABYSS_PERMIT_TIMEOUT_MS` before it counts as refused. It reads `PA_MAX_CONCURRENT_REQUESTS`
 * and, when bound, `PA_RATE_LIMITER` from the market Worker's environment, which `props.ts` declares.
 */
export class PearlAbyssCoordinator extends Cloudflare.DurableObject<PearlAbyssCoordinator>()(
  PEARL_ABYSS_COORDINATOR,
  Effect.gen(function* () {
    // The market Worker's environment, which a deploy's plan leaves undefined; only a running coordinator reads it.
    const env: Record<string, unknown> | undefined = yield* Cloudflare.Workers.WorkerEnvironment;
    return Effect.sync(() => {
      if (env === undefined) throw new TypeError("The coordinator ran without the market Worker's environment.");
      const coordination = new PearlAbyssCoordination({
        maximumConcurrentRequests: maximumConcurrentRequestsFromBinding(env.PA_MAX_CONCURRENT_REQUESTS),
        limiter: rateLimiterOf(env.PA_RATE_LIMITER),
      });
      return {
        fetch: Effect.gen(function* () {
          const request = nativeRequest(yield* HttpServerRequest);
          return HttpServerResponse.fromWeb(yield* Effect.promise(() => coordination.execute(request)));
        }),
      };
    });
  }),
) {}

/** The market subgraph Worker: `@agris/market-worker` hosted by Alchemy, with the coordinators it reaches. */
export default AgrisMarket.make(
  Stack.useSync(({ stage }) =>
    deployProps(import.meta.url, () => marketProps(stageSettings(stage, deployEnvironment()))),
  ),
  Effect.gen(function* () {
    yield* PearlAbyssCoordinator;

    const execute = Effect.fnUntraced(function* (
      request: Request,
      reserveBudget: InvocationBudgetReservation,
      reserveMarketSummary: MarketSummaryReservation,
    ) {
      // The environment exists whenever the Worker runs; reading it as an option keeps it out of the RPC contract.
      const environment = yield* Effect.serviceOption(Cloudflare.Workers.WorkerEnvironment);
      const coordinators = coordinatorNamespace(Option.getOrThrow(environment));
      const coordinatorFor = (hostname: string): PearlAbyssCoordinatorPort => {
        const { name, locationHint } = pearlAbyssCoordinatorAddress(hostname);
        const coordinator = coordinators.getByName(name, { locationHint });
        return { execute: (upstream) => coordinator.fetch(upstream) };
      };
      return yield* Effect.promise(() =>
        executeMarketSubgraph(request, coordinatorFor, reserveBudget, reserveMarketSummary),
      );
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Request;
        const ready = readinessResponse(request);
        if (ready !== null) return HttpServerResponse.fromWeb(ready);
        const env: object = yield* Cloudflare.Workers.WorkerEnvironment;
        const budget = standaloneBudget(
          Predicate.hasProperty(env, "SUBREQUEST_LIMIT") ? env.SUBREQUEST_LIMIT : undefined,
        );
        return HttpServerResponse.fromWeb(yield* execute(request, budget.reserveBudget, budget.reserveMarketSummary));
      }),
      fetchWithBudget: (
        request: Request,
        reserveBudget: InvocationBudgetReservation,
        reserveMarketSummary: MarketSummaryReservation,
      ) => execute(request, reserveBudget, reserveMarketSummary),
    };
  }),
);

/* BOUNDARY: The Durable Object's request wraps the native Request it was called with; it is checked to be one. */
function nativeRequest(request: HttpServerRequest): Request {
  if (!(request.source instanceof Request)) throw new TypeError("The coordinator was called without a native Request.");
  return request.source;
}

/* BOUNDARY: The `PA_RATE_LIMITER` binding, when the stage binds one; it is checked to be a rate limiter. */
function rateLimiterOf(binding: unknown): PearlAbyssRateLimiter | undefined {
  if (binding === undefined) return undefined;
  if (!Predicate.hasProperty(binding, "limit") || !Predicate.isFunction(binding.limit)) {
    throw new TypeError("PA_RATE_LIMITER is bound but is not a rate limiter.");
  }
  const limit = binding.limit;
  return {
    limit: async (options) => {
      const outcome: unknown = await limit.call(binding, options);
      return { success: Predicate.hasProperty(outcome, "success") && outcome.success === true };
    },
  };
}

interface CoordinatorNamespace {
  getByName(
    name: string,
    options: { readonly locationHint: DurableObjectLocationHint },
  ): { fetch(request: Request): Promise<Response> };
}

/**
 * The coordinator's native namespace binding, which `yield* PearlAbyssCoordinator` declared under its logical id.
 *
 * The market calls the coordinator's `fetch` on the native stub rather than through the typed RPC stub, because only a
 * fetch carries the request's AbortSignal.
 */
/* BOUNDARY: The Worker environment is untyped; the binding is checked to be a namespace before it is called. */
function coordinatorNamespace(env: object): CoordinatorNamespace {
  const binding: unknown = Predicate.hasProperty(env, PEARL_ABYSS_COORDINATOR)
    ? env[PEARL_ABYSS_COORDINATOR]
    : undefined;
  if (!Predicate.hasProperty(binding, "getByName") || !Predicate.isFunction(binding.getByName)) {
    throw new TypeError(`The market Worker has no ${PEARL_ABYSS_COORDINATOR} namespace binding.`);
  }
  const getByName = binding.getByName;
  return {
    getByName: (name, options) => {
      const stub: unknown = getByName.call(binding, name, options);
      if (!Predicate.hasProperty(stub, "fetch") || !Predicate.isFunction(stub.fetch)) {
        throw new TypeError(`The ${PEARL_ABYSS_COORDINATOR} namespace returned no fetchable stub.`);
      }
      const fetch = stub.fetch;
      return { fetch: (request) => fetch.call(stub, request) };
    },
  };
}
