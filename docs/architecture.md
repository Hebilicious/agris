# Architecture

Agris is a gateway Worker, its cache Worker and two subgraph Workers, deployed together as one stage of the Alchemy stack in `infra/` ([deploy.md](deploy.md)). Only the gateway can be reached from outside; it calls the others over Service Bindings.

```text
client
  │  HTTPS: POST/GET /graphql
  ▼
agris (gateway Worker)
  │  validate → limit → cache lookup → Hive Gateway federation plan
  │
  ├── Service Binding ──▶ agris-cache (Workers Cache in front of execution)
  │
  ├── Service Binding ──▶ agris-catalog (catalog subgraph Worker)
  │                          bundled catalog + trigram search index
  │
  └── Service Binding ──▶ agris-market (market subgraph Worker)
                             │
                             ▼
                          PearlAbyssCoordinator Durable Object (one per upstream host)
                             │  HTTPS POST /TradeMarket/<endpoint>
                             ▼
                          Pearl Abyss regional trade servers
```

## Gateway (`apps/gateway`, `packages/core`)

The gateway owns the public protocol and nothing about the market itself.

1. **Normalize.** `@agris/core`'s request protocol parses the request, rejects anything that is not one query operation valid against the client schema, coerces the variables, and prints a canonical document. The canonical document plus canonical variables give the request its cache identity.
2. **Limit.** The body is read with a hard 64 KiB ceiling. Documents are checked for depth, aliases and size. A rate-limit binding keyed by client IP answers `429` with `Retry-After`.
3. **Choose a cache policy.** The policy walks the selection set (fragments, `@skip` and `@include` included) and takes the shortest freshness window among the fields it finds, so a price nested under a year-long catalog field still keeps for a minute. The windows come from a policy value: `DEFAULT_CACHE_FRESHNESS`, with the deployment's `CACHE_*` variables applied when it sets any. See [api.md](api.md#caching).
4. **Execute.** A cacheable request goes through Cloudflare's cache, which sits in front of execution; an uncacheable one executes directly. Deployed by Alchemy, the cached execution is the `agris-cache` Worker, reached over a Service Binding with the operation in a header, because Alchemy enables Workers Cache for a whole script. Deployed from the gateway's own entrypoint, as a host does, it is the `CachedAgrisProxy` entrypoint, reached through `ctx.exports`. Execution runs on one Hive Gateway runtime per isolate, built on first use over the committed supergraph with the Envelop plugins in `apps/gateway/src/plugins.ts`, and routes each execution's subgraph fetches, through its context, to the market and catalog Service Bindings.
5. **Classify.** Responses with GraphQL errors are never stored. If every subgraph call failed the execution answers `503 no-store`, so an outage cannot overwrite a good cached answer, and the edge can keep serving the old one for the policy's `stale-if-error` window, a day by default. If no subgraph call succeeded because the market's Pearl Abyss limit throttled its reads, the execution answers the same `503 no-store`, with `Retry-After` and an internal marker, because a 5xx is what makes the edge serve a stored answer stale: a throttled refresh of a cached query serves the cached answer. Only when the edge had nothing to serve does the gateway turn the marked `503` into `429` with `Retry-After`, and it never sends the marker on. A read the invocation budget refused is a `QUERY_BUDGET_EXCEEDED` field error in a `200`, never an outage.

Each request carries an invocation budget (`@agris/invocation-budget`): `SUBREQUEST_LIMIT` subrequests, 50 by default, counting subgraph calls and Pearl Abyss requests together, and at most six distinct market-summary batches. The gateway, cache and market Workers deploy with `limits.subrequests` equal to the budget; the catalog Worker makes no subrequests and sets none. Work beyond the budget fails before it is issued, as a `QUERY_BUDGET_EXCEEDED` error on the fields it could not read.

### Entrypoints

`@agris/gateway-worker` exports:

| Export             | Cache   | Use                                                                               |
| ------------------ | ------- | --------------------------------------------------------------------------------- |
| `default`          | none    | The public HTTP handler, and the entrypoint a host binds when it wants no caching |
| `CachedAgrisProxy` | enabled | Execution behind Cloudflare's cache; the gateway reaches it through `ctx.exports` |

`src/local.ts` exports the same entrypoints for local development, with the catalog served inline instead of over a binding; it reads `SUBREQUEST_LIMIT` and the `CACHE_*` settings as the deployed gateway does.

### Embedding Agris in your Cloudflare app

If your own Worker should be the only caller, deploy Agris without relying on the public URL and bind the gateway from your Worker:

```ts
// your-app/alchemy.run.ts, inside your stack
const app =
  yield *
  Cloudflare.Worker("MyApp", {
    main: "./src/index.ts",
    env: { AGRIS: yield * Cloudflare.Worker.ref("AgrisGateway", { stack: "Agris", stage: "production" }) },
  });
```

Any other deploy tool works the same way: bind a service named `agris` (the gateway's Worker name) as `AGRIS`.

```ts
// your-worker/src/index.ts
const response = await env.AGRIS.fetch("https://agris/graphql", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query, variables }),
});
```

The binding reaches the gateway's `default` handler, so requests go through the same validation as public traffic. Two more ways to embed:

- **Your own deploy wrapper.** A host repository can mount Agris (for example as a git submodule), add `packages/*` and `apps/*` to its pnpm workspace, and deploy its own Workers whose entry modules re-export `@agris/gateway-worker`, `@agris/market-worker` and `@agris/catalog-worker`. Every `moon.yml` in Agris uses project-relative inputs for this reason. The host keeps its own worker names, bindings and rate-limit namespaces.
- **Keep it private.** Deploy with `AGRIS_WORKERS_DEV=false` and no `AGRIS_DOMAIN`, so only Service Bindings reach the gateway.

The gateway, market and catalog logic lives in `src/gateway.ts`, `src/public-gateway.ts`, `src/market.ts` and `src/catalog.ts`, which import nothing from the Workers runtime. The Workers' own entrypoints (`index.ts`, `public.ts`, `local.ts`), which a host deploys and the smoke stage deploys the same way, and the Alchemy Workers in `infra/src` all serve through them, so the two ways of deploying cannot drift apart.

## Catalog subgraph (`apps/catalog`, `packages/catalog-subgraph`)

The catalog subgraph owns the `Item` entity: `id`, `locale`, `name`, `grade`, and item-name search.

- **Data.** The item catalog shipped in the repository (`data/catalog/<locale>/items.json`): 12,508 items, 12 locales. `catalog-tools:validate` checks that every locale has exactly the English item IDs and grades and rejects wrong-script names and any name identical to English that `data/catalog/same-as-english.json` does not list; `catalog-tools:generate` builds `packages/catalog-subgraph/src/generated-catalog-search-artifact.ts` from it, with folded search keys and one compact trigram index per locale.
- **Runtime.** The Worker bundles that artifact and loads it at startup; each locale's names, search keys and index are decoded the first time a request reads that locale. Lookups and search run in memory; there is no KV, database or outbound call. Updating names means regenerating the artifact and redeploying the catalog Worker.
- **Why in memory.** A lookup or search costs no `fetch`, KV read or database query, so nothing counts against the subrequest budget and nothing can time out; there is no storage to provision or pay for; and the data changes only with a release, so a deploy is an atomic switch and the gateway can cache catalog answers for a year under keys that include a checksum of the catalog data. The cost is size: the catalog Worker is the largest bundle (`moon run agris:bundle` prints every Worker's size), parsed once at startup.
- **Search.** A query is folded the same way as the names (NFKC, locale-aware lowercase, Latin accents removed, whitespace and punctuation removed). Its trigrams select the shortest posting list, and every candidate is confirmed with `includes`. The result is exact: no false positives, no typo correction. Background in [research/in-memory-name-search.md](research/in-memory-name-search.md).

## Market subgraph (`apps/market`, `packages/market-subgraph`, `packages/pearl-abyss`)

The market subgraph owns `Market`, `MarketItem` and `Item.marketSummary`. It returns `Item` references by `(id, locale)`; the gateway joins names from the catalog.

`@agris/pearl-abyss` is the only code that knows Pearl Abyss request bodies, positional rows, Huffman-compressed responses and regional hosts. It covers seven upstream capabilities:

| Graph field                          | Pearl Abyss endpoint       |
| ------------------------------------ | -------------------------- |
| `Market.items`, `Item.marketSummary` | `GetWorldMarketSearchList` |
| `MarketItem.listings`                | `GetWorldMarketSubList`    |
| `MarketItem.orderBook`               | `GetBiddingInfoList`       |
| `MarketItem.priceHistory`            | `GetMarketPriceInfo`       |
| `Market.catalog`                     | `GetWorldMarketList`       |
| `Market.hotItems`                    | `GetWorldMarketHotList`    |
| `Market.registrations`               | `GetWorldMarketWaitList`   |

Summary reads are batched: every `marketSummary` at the same query path, and every ID in `Market.items(ids:)`, becomes one upstream request with up to 100 distinct IDs. The detail fields cost one upstream request per item.

### Request coordination

Every upstream call goes through the `PearlAbyssCoordinator` Durable Object, one instance per upstream host, created next to that host's server: each region's coordinator is named `<hint>:<host>` and created with that Durable Object location hint (`PEARL_ABYSS_COORDINATOR_LOCATIONS` in `apps/market/src/market.ts`; [deploy.md](deploy.md#upstream-pearl-abyss) explains how the hints were measured). Inside it:

- identical requests that are pending at the same time share one fetch;
- at most `PA_MAX_CONCURRENT_REQUESTS` (default 6) distinct requests run at once, and the rest wait in FIFO order; `0` or no setting runs them all at once;
- a rate-limit binding (default 100 per 10 seconds) acts as a burst backstop; a denied or failed limiter call means no fetch, and a deployment without the binding sets no rate;
- a request that times out after 30 seconds is not retried;
- upstream responses are read with a byte ceiling and rejected if their shape is unexpected.

The coordinator holds no queue on disk and no results after they settle; it is not a cache. If it restarts, in-flight callers fail and the gateway's stale cache covers them.

## Generated artifacts

| Artifact                                                                                    | Generator                         | Check                                    |
| ------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------- |
| `tools/schema/artifacts/*` (supergraph, client schema, introspection, persisted operations) | `moon run schema:generate`        | `schema:check`, `schema:generated-check` |
| `packages/catalog-subgraph/src/generated-catalog-search-artifact.ts`                        | `moon run catalog-tools:generate` | `catalog-tools:search-artifact-check`    |

`moon run agris:generate` runs both. Never edit generated files by hand.
