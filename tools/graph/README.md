# Graph tools

Composes the market and catalog subgraphs into the supergraph and the client schema, and writes them with the introspection result and the persisted-operation manifest under `artifacts/`. The artifacts are committed; `moon run graph:generate` rewrites them and `moon run graph:generated-check` proves the committed copies match.

`src/generate.ts` lists the persisted operations. `MarketItemsWithCatalog` is the example; add an operation there and regenerate.
