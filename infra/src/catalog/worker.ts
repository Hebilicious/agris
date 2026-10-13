import { executeCatalogSubgraph } from "@agris/catalog-worker/catalog";
import type { InvocationBudgetReservation, MarketSummaryReservation } from "@agris/invocation-budget";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { stageSettings } from "../settings.ts";
import { deployEnvironment, deployProps } from "../stack.ts";
import { AgrisCatalog } from "./contract.ts";
import { catalogProps } from "./props.ts";

/**
 * The catalog subgraph Worker: `@agris/catalog-worker` hosted by Alchemy.
 *
 * It serves the generated catalog from memory, so it binds nothing, and it spends no upstream requests, so it never
 * draws on the budget the gateway hands it. The catalog module loads at startup, which Cloudflare bounds separately
 * (one second), so no request pays for parsing it; each locale's names and index are decoded on the first request
 * that reads them.
 */
export default AgrisCatalog.make(
  Stack.useSync(({ stage }) =>
    deployProps(import.meta.url, () => catalogProps(stageSettings(stage, deployEnvironment()))),
  ),
  Effect.sync(() => {
    const execute = (request: Request) => Effect.promise(() => executeCatalogSubgraph(request));
    return {
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Request;
        return HttpServerResponse.fromWeb(yield* execute(request));
      }),
      fetchWithBudget: (
        request: Request,
        _reserveBudget: InvocationBudgetReservation,
        _reserveMarketSummary: MarketSummaryReservation,
      ) => execute(request),
    };
  }),
);
