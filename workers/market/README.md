# @agris/market-worker

The Agris market subgraph Worker. It serves the market subgraph through its `BudgetedMarketSubgraph` entrypoint and coordinates every Pearl Abyss call through the `PearlAbyssCoordinator` Durable Object, with a concurrency limit and a rate limit.

`src/index.ts` exports `default`, `BudgetedMarketSubgraph`, `PearlAbyssCoordinator` and the bindings they read (`MarketEnv`). `cloudflare.config.ts` defines this repository's modes: `production` (`agris-market`), `staging` and `local`.
