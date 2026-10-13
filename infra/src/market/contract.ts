import type { InvocationBudgetReservation, MarketSummaryReservation } from "@agris/invocation-budget";
import * as Cloudflare from "alchemy/Cloudflare";
import type * as Effect from "effect/Effect";

/**
 * The market subgraph Worker as the gateway sees it: the gateway binds this tag and calls `fetchWithBudget`, without
 * bundling the market itself.
 *
 * The reservations travel as Workers RPC stubs, so every upstream request the market makes counts against the
 * operation that caused it.
 */
export class AgrisMarket extends Cloudflare.Worker<
  AgrisMarket,
  {
    fetchWithBudget: (
      request: Request,
      reserveBudget: InvocationBudgetReservation,
      reserveMarketSummary: MarketSummaryReservation,
    ) => Effect.Effect<Response>;
  }
>()("AgrisMarket") {}
