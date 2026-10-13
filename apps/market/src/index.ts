import type { InvocationBudgetReservation, MarketSummaryReservation } from "@agris/invocation-budget";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import type { MarketEnv } from "./env.js";
import {
  executeMarketSubgraph,
  maximumConcurrentRequestsFromBinding,
  PEARL_ABYSS_ALLOWANCE_ADDRESS,
  pearlAbyssCoordinatorAddress,
  PearlAbyssCoordinatorObject,
  readinessResponse,
  standaloneBudget,
  type PearlAbyssCoordinatorAddress,
  type PearlAbyssCoordinatorPort,
} from "./market.js";

export type { MarketEnv } from "./env.js";

export class BudgetedMarketSubgraph extends WorkerEntrypoint<MarketEnv> {
  public fetch(request: Request): Promise<Response> {
    const budget = standaloneBudget(this.env.SUBREQUEST_LIMIT);
    return executeMarketSubgraph(request, coordinatorFor(this.env), budget.reserveBudget, budget.reserveMarketSummary);
  }

  public fetchWithBudget(
    request: Request,
    reserveBudget: InvocationBudgetReservation,
    reserveMarketSummary: MarketSummaryReservation,
  ): Promise<Response> {
    return executeMarketSubgraph(request, coordinatorFor(this.env), reserveBudget, reserveMarketSummary);
  }
}

/**
 * One coordinator per Pearl Abyss host, placed by its name's location hint next to the server that answers it. It
 * admits each distinct upstream request once, within `PA_MAX_CONCURRENT_REQUESTS`, after a permit from the one object
 * at `PEARL_ABYSS_ALLOWANCE_ADDRESS`, which alone consults `PA_RATE_LIMITER` when it is bound.
 *
 * A caller's abort reaches it only when the Worker runs with the `enable_request_signal` compatibility flag; without
 * it, a read whose caller gave up still waits its turn and is sent, until its 30-second deadline drops it.
 */
export class PearlAbyssCoordinator extends DurableObject<MarketEnv> {
  private readonly coordinator: PearlAbyssCoordinatorObject;

  public constructor(state: DurableObjectState, env: MarketEnv) {
    super(state, env);
    this.coordinator = new PearlAbyssCoordinatorObject({
      maximumConcurrentRequests: maximumConcurrentRequestsFromBinding(env.PA_MAX_CONCURRENT_REQUESTS),
      limiter: env.PA_RATE_LIMITER,
      allowance: () => coordinatorAt(env, PEARL_ABYSS_ALLOWANCE_ADDRESS),
    });
  }

  public fetch(request: Request): Promise<Response> {
    return this.coordinator.execute(request);
  }
}

export const marketWorker = {
  fetch(request: Request, env: MarketEnv): Promise<Response> {
    const ready = readinessResponse(request);
    if (ready !== null) return Promise.resolve(ready);
    const budget = standaloneBudget(env.SUBREQUEST_LIMIT);
    return executeMarketSubgraph(request, coordinatorFor(env), budget.reserveBudget, budget.reserveMarketSummary);
  },
} satisfies ExportedHandler<MarketEnv>;

export default marketWorker;

function coordinatorFor(env: MarketEnv): (hostname: string) => PearlAbyssCoordinatorPort {
  return (hostname) => coordinatorAt(env, pearlAbyssCoordinatorAddress(hostname));
}

function coordinatorAt(env: MarketEnv, address: PearlAbyssCoordinatorAddress): PearlAbyssCoordinatorPort {
  const coordinator = env.PA_COORDINATOR.getByName(address.name, { locationHint: address.locationHint });
  return { execute: (request) => coordinator.fetch(request) };
}
