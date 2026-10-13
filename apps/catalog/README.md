# @agris/catalog-worker

The Agris catalog subgraph Worker. It serves the immutable in-memory catalog through its `BudgetedCatalogSubgraph` entrypoint and reads no bindings.

`src/catalog.ts` answers a catalog request, independent of its host. `src/index.ts` exports `default` and `BudgetedCatalogSubgraph`. The smoke stage in `infra/src/smoke/` deploys `src/index.ts` as a host would; the runtime evidence and the catalog release diagnostic run its bundle (`moon run agris:bundle`).
