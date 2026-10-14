import type { InvocationBudgetReservation, MarketSummaryReservation } from "@agris/invocation-budget";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import type { MarketEnv } from "./env.js";
import {
  executeMarketSubgraph,
  maximumConcurrentRequestsFromBinding,
  PearlAbyssCoordination,
  pearlAbyssCoordinatorAddress,
  readinessResponse,
  standaloneBudget,
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
 * admits each distinct upstream request once, within `PA_MAX_CONCURRENT_REQUESTS`, behind `PA_RATE_LIMITER` when bound.
 *
 * A caller's abort reaches it only when the Worker runs with the `enable_request_signal` compatibility flag; without
 * it, a read whose caller gave up still waits its turn and is sent, until its 30-second deadline drops it.
 */
export class PearlAbyssCoordinator extends DurableObject<MarketEnv> {
  private readonly coordination: PearlAbyssCoordination;

  public constructor(state: DurableObjectState, env: MarketEnv) {
    super(state, env);
    this.coordination = new PearlAbyssCoordination({
      maximumConcurrentRequests: maximumConcurrentRequestsFromBinding(env.PA_MAX_CONCURRENT_REQUESTS),
      limiter: env.PA_RATE_LIMITER,
    });
  }

  public fetch(request: Request): Promise<Response> {
    return this.coordination.execute(request);
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
  return (hostname) => {
    const { name, locationHint } = pearlAbyssCoordinatorAddress(hostname);
    const coordinator = env.PA_COORDINATOR.getByName(name, { locationHint });
    return { execute: (request) => coordinator.fetch(request) };
  };
}
