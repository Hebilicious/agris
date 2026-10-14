# @agris/gateway-worker

The Agris gateway Worker. It federates the market and catalog subgraph Workers, which it reaches through Service Bindings, and serves storable operations through an edge-cached execution.

- `src/gateway.ts` and `src/public-gateway.ts` are the private and public gateway, independent of their host: they import nothing from the Workers runtime, so the Alchemy Workers in `infra/` load them too.
- `src/index.ts` exports the private entrypoints (`default`, `CachedAgrisProxy`) and the bindings they read (`GatewayEnv`); `src/public.ts` the public surface (`default`, `AgrisProxy`, `CachedAgrisProxy`, `GatewayAdmission`, `PublicGatewayEnv`); `src/local.ts` local entrypoints that serve the catalog inline, for a host's own local runtime (Agris's `moon run agris:dev` runs the Alchemy stack instead). A host deploys them by re-exporting them from its own entry module.
- `src/plugins.ts` is the Envelop plugin list every execution runs, empty by default.

The gateway reads its optional `CACHE_*`, `QUERY_*` and `MARKET_CLIENT_LIMIT_*` variables, `GRAPHIQL`, the optional `CLIENT_RATE_LIMITER` and `GLOBAL_RATE_LIMITER` bindings, which every public request passes, and the `ADMISSION` Durable Object binding to the `GatewayAdmission` class `src/public.ts` exports, whose exact token buckets (`src/admission.ts`), one per client in each object's SQLite-backed storage, admit an execution's market calls before the first one; [docs/deploy.md](../../docs/deploy.md#configuration) lists them. `src/env.ts` declares the bindings each entrypoint reads; the smoke stage in `infra/src/smoke/` deploys `src/index.ts` as a host would, and the Workers runtime evidence in `tests/` runs `src/public.ts`.
