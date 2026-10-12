# Architecture

Agris is three Cloudflare Workers. Only the gateway can be reached from outside; it calls the two subgraph Workers over Service Bindings.

```text
client
  │  HTTPS: POST/GET /graphql
  ▼
agris (gateway Worker)
  │  validate → limit → cache lookup → Hive Gateway federation plan
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

## Gateway (`workers/gateway`, `packages/core`)

The gateway owns the public protocol and nothing about the market itself.

1. **Normalize.** `@agris/core`'s request protocol parses the request, rejects anything that is not one query operation valid against the client schema, coerces the variables, and prints a canonical document. The canonical document plus canonical variables give the request its cache identity.
2. **Limit.** The body is read with a hard 64 KiB ceiling. Documents are checked for depth, aliases and size. A rate-limit binding keyed by client IP answers `429` with `Retry-After`.
3. **Choose a cache policy.** The policy walks the selection set (fragments, `@skip` and `@include` included) and takes the shortest freshness window among the fields it finds. `searchItems` and `Item.marketSummary` make the response uncacheable. See [api.md](api.md#caching).
4. **Execute.** A cacheable request goes to the `CachedAgrisProxy` entrypoint through the Worker's own `ctx.exports`, so Cloudflare's cache sits in front of execution; an uncacheable one executes directly. Execution builds a Hive Gateway runtime over the committed supergraph and routes subgraph fetches to the `MARKET` and `CATALOG` Service Bindings.
5. **Classify.** Responses with GraphQL errors are never stored. If every subgraph call failed the gateway answers `503 no-store`, so an outage cannot overwrite a good cached answer, and the edge can keep serving the old one for up to a day (`stale-if-error`).

Each request carries an invocation budget (`@agris/invocation-budget`): 1,000 subrequests, and at most six distinct market-summary batches. Work beyond the budget fails before it is issued.

### Entrypoints

`@agris/gateway-worker` exports:

| Export             | Cache   | Use                                                                               |
| ------------------ | ------- | --------------------------------------------------------------------------------- |
| `default`          | none    | The public HTTP handler, and the entrypoint a host binds when it wants no caching |
| `CachedAgrisProxy` | enabled | Execution behind Cloudflare's cache; the gateway reaches it through `ctx.exports` |

`src/local.ts` exports the same entrypoints for local development, with the catalog served inline instead of over a binding.

### Embedding Agris in your Cloudflare app

If your own Worker should be the only caller, deploy Agris without relying on the public URL and bind the gateway from your Worker:

```ts
// your-worker/cloudflare.config.ts
import { bindings, defineWorker } from "cf/config";

export default defineWorker({
  name: "my-app",
  entrypoint: "./src/index.ts",
  env: {
    AGRIS: bindings.worker({ worker: "agris" }),
  },
});
```

```ts
// your-worker/src/index.ts
const response = await env.AGRIS.fetch("https://agris/graphql", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query, variables }),
});
```

The binding reaches the gateway's `default` handler, so requests go through the same validation as public traffic. Two more ways to embed:

- **Your own deploy wrapper.** A host repository can mount Agris (for example as a git submodule), add `packages/*` and `workers/*` to its pnpm workspace, and deploy its own Workers whose entry modules re-export `@agris/gateway-worker`, `@agris/market-worker` and `@agris/catalog-worker`. Every `moon.yml` in Agris uses project-relative inputs for this reason. The host keeps its own worker names, bindings and rate-limit namespaces.
- **Keep it private.** Set `workersDev: false` on the gateway in your copy of `workers/gateway/cloudflare.config.ts` so only Service Bindings reach it.

## Catalog subgraph (`workers/catalog`, `packages/catalog-subgraph`)

The catalog subgraph owns the `Item` entity: `id`, `locale`, `name`, `grade`, and item-name search.

- **Data.** The item catalog shipped in the repository (`tools/catalog/data/<locale>/items.json`): 12,508 items, 12 locales. `catalog-tools:validate` checks that every locale has exactly the English item IDs and grades and rejects wrong-script names and any name identical to English that `tools/catalog/data/same-as-english.json` does not list; `catalog-tools:generate` builds `packages/catalog-subgraph/src/generated-catalog-search-artifact.ts` from it, with folded search keys and one compact trigram index per locale.
- **Runtime.** The Worker bundles that artifact. Lookups and search run in memory; there is no KV, database or outbound call. Updating names means regenerating the artifact and redeploying the catalog Worker. [free-plan.md](free-plan.md) explains the choice and proposes a D1-backed alternative.
- **Search.** A query is folded the same way as the names (NFKC, locale-aware lowercase, Latin accents removed, whitespace and punctuation removed). Its trigrams select the shortest posting list, and every candidate is confirmed with `includes`. The result is exact: no false positives, no typo correction. Background in [research/in-memory-name-search.md](research/in-memory-name-search.md).

## Market subgraph (`workers/market`, `packages/market-subgraph`, `packages/pearl-abyss`)

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

Every upstream call goes through the `PearlAbyssCoordinator` Durable Object, one instance per upstream host. Inside it:

- identical requests that are pending at the same time share one fetch;
- at most `PA_MAX_CONCURRENT_REQUESTS` (default 6) distinct requests run at once, and the rest wait in FIFO order;
- a rate-limit binding (100 per 10 seconds) acts as a burst backstop; a denied or failed limiter call means no fetch;
- a request that times out after 30 seconds is not retried;
- upstream responses are read with a byte ceiling and rejected if their shape is unexpected.

The coordinator holds no queue on disk and no results after they settle; it is not a cache. If it restarts, in-flight callers fail and the gateway's stale cache covers them.

## Generated artifacts

| Artifact                                                                                   | Generator                         | Check                                  |
| ------------------------------------------------------------------------------------------ | --------------------------------- | -------------------------------------- |
| `tools/graph/artifacts/*` (supergraph, client schema, introspection, persisted operations) | `moon run graph:generate`         | `graph:check`, `graph:generated-check` |
| `packages/catalog-subgraph/src/generated-catalog-search-artifact.ts`                       | `moon run catalog-tools:generate` | `catalog-tools:search-artifact-check`  |

`moon run agris:generate` runs both. Never edit generated files by hand.
