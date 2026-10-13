import type { ServiceBindingPort } from "@agris/core";
import type { AgrisProxyRuntimeEnv } from "@agris/gateway-worker/gateway";
import type { InvocationBudgetReservation, MarketSummaryReservation } from "@agris/invocation-budget";
import * as Cloudflare from "alchemy/Cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { AgrisCatalog } from "../catalog/contract.ts";
import { AgrisMarket } from "../market/contract.ts";

interface BudgetedSubgraph {
  fetchWithBudget(
    request: Request,
    reserveBudget: InvocationBudgetReservation,
    reserveMarketSummary: MarketSummaryReservation,
  ): Effect.Effect<Response, unknown, RuntimeContext>;
}

/**
 * Bind the market and catalog subgraph Workers, and give each request the ports that reach them.
 *
 * The gateway calls its subgraphs through Promise ports, so each port runs the RPC call with the request's own
 * services.
 */
export const bindSubgraphs = Effect.gen(function* () {
  const market = yield* Cloudflare.Workers.bindWorker(AgrisMarket);
  const catalog = yield* Cloudflare.Workers.bindWorker(AgrisCatalog);
  return Effect.gen(function* () {
    const run = Effect.runPromiseWith(yield* Effect.context<RuntimeContext>());
    // The gateway reports a failed subgraph call only as unavailable, so the RPC failure is logged where it happens.
    const port = (subgraph: BudgetedSubgraph): ServiceBindingPort => ({
      fetch: (request, reserveBudget, reserveMarketSummary) =>
        run(
          subgraph
            .fetchWithBudget(request, reserveBudget, reserveMarketSummary)
            .pipe(Effect.tapCause((cause) => Effect.logError(`Subgraph RPC failed: ${Cause.pretty(cause)}`))),
        ),
    });
    const subgraphs: Pick<AgrisProxyRuntimeEnv, "MARKET" | "CATALOG"> = {
      MARKET: port(market),
      CATALOG: port(catalog),
    };
    return subgraphs;
  });
});
