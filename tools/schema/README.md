# Schema tools

Composes the market and catalog subgraphs into the supergraph and the client schema, and writes them with the introspection result and the persisted-operation manifest under `artifacts/`. The artifacts are committed; `moon run schema:generate` rewrites them and `moon run schema:generated-check` proves the committed copies match.

`moon run schema:check` validates the persisted operations against the client schema and enforces its documentation (`src/schema-documentation.ts`): every type, field, argument, enum value and input field has a description, which GraphiQL's docs explorer shows; and the two subgraphs never describe a shared element differently, since composition would keep only one. Write descriptions in the subgraphs' Pothos builders, then regenerate.

`src/generate.ts` lists the persisted operations. `MarketItemsWithCatalog` is the example; add an operation there and regenerate.
