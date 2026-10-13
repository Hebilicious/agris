import type { InvocationBudgetReservation, MarketSummaryReservation } from "@agris/invocation-budget";
import { WorkerEntrypoint } from "cloudflare:workers";

import { executeCatalogSubgraph } from "./catalog.js";
import type { CatalogEnv } from "./env.js";
export type { CatalogEnv } from "./env.js";

export class BudgetedCatalogSubgraph extends WorkerEntrypoint<CatalogEnv> {
  public fetch(request: Request): Promise<Response> {
    return executeCatalogSubgraph(request);
  }

  public fetchWithBudget(
    request: Request,
    _reserveBudget: InvocationBudgetReservation,
    _reserveMarketSummary: MarketSummaryReservation,
  ): Promise<Response> {
    return executeCatalogSubgraph(request);
  }
}

export const catalogWorker = {
  fetch(request: Request): Promise<Response> {
    return executeCatalogSubgraph(request);
  },
} satisfies ExportedHandler<CatalogEnv>;

export default catalogWorker;
