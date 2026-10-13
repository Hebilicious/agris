import type { InvocationBudgetReservation, MarketSummaryReservation } from "@agris/invocation-budget";
import * as Cloudflare from "alchemy/Cloudflare";
import type * as Effect from "effect/Effect";

/**
 * The catalog subgraph Worker as the gateway sees it: the gateway binds this tag and calls `fetchWithBudget`, without
 * bundling the catalog itself.
 */
export class AgrisCatalog extends Cloudflare.Worker<
  AgrisCatalog,
  {
    fetchWithBudget: (
      request: Request,
      reserveBudget: InvocationBudgetReservation,
      reserveMarketSummary: MarketSummaryReservation,
    ) => Effect.Effect<Response>;
  }
>()("AgrisCatalog") {}
