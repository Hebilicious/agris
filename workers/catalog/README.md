# @agris/catalog-worker

The Agris catalog subgraph Worker. It serves the immutable in-memory catalog through its `BudgetedCatalogSubgraph` entrypoint and reads no bindings.

`src/index.ts` exports `default` and `BudgetedCatalogSubgraph`. `cloudflare.config.ts` defines this repository's modes: `production` (`agris-catalog`), `staging` and `local`.
