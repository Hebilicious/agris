# @agris/market-worker

The Agris market subgraph Worker. It serves the market subgraph through its `BudgetedMarketSubgraph` entrypoint and coordinates every Pearl Abyss call through the `PearlAbyssCoordinator` Durable Object, one per upstream host, each created with the location hint of the server it calls.

`src/market.ts` holds the subgraph and the coordination, independent of their host. `src/index.ts` exports `default`, `BudgetedMarketSubgraph`, `PearlAbyssCoordinator` and the bindings they read (`MarketEnv`); `PA_MAX_CONCURRENT_REQUESTS` and `PA_RATE_LIMITER` are optional, and absent sets no limit. The smoke stage in `infra/src/smoke/` deploys `src/index.ts` as a host would, and the Workers runtime evidence in `tests/` runs its bundle.
