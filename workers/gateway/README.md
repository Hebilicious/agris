# @agris/gateway-worker

The Agris gateway Worker. It federates the market and catalog subgraph Workers, which it reaches through Service Bindings, and caches responses through its `CachedAgrisProxy` entrypoint.

`src/index.ts` exports the deployed entrypoints (`default`, `CachedAgrisProxy`) and the bindings they read (`GatewayEnv`); `src/local.ts` exports the local entrypoints, which serve the catalog inline. A host can deploy them by re-exporting them from its own entry module. `cloudflare.config.ts` defines this repository's modes: `production` (`agris`), `staging`, `smoke` and `local`.
