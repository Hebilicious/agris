import { createCatalogSubgraph } from "@agris/catalog-subgraph";
import type { InvocationBudgetReservation, MarketSummaryReservation } from "@agris/invocation-budget";
import { WorkerEntrypoint } from "cloudflare:workers";

import type { CatalogEnv } from "./env.js";
export type { CatalogEnv } from "./env.js";

const catalogSubgraph = createCatalogSubgraph();

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

async function executeCatalogSubgraph(request: Request): Promise<Response> {
  const response = await catalogSubgraph.fetch(request);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
