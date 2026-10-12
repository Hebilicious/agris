# Agris

**The Black Desert Online Central Market as a typed GraphQL API.** Prices, stock, order books and price history for all 12 market regions, with item names in 12 languages and a name search. It runs on your own Cloudflare account.

[Website and demo](https://agris-demo.hebilicious.workers.dev) · [Deploy guide](docs/deploy.md) · [API reference](docs/api.md) · [Schema](tools/graph/artifacts/client-schema.graphql)

## Why use it

- **A schema instead of guesswork.** Pearl Abyss's trade servers answer with undocumented positional rows, some Huffman-compressed. Agris gives you named, typed fields.
- **Item names, joined in.** The market only knows numeric IDs. Agris adds names and grades for 12,508 items in 12 languages.
- **Name search.** `searchItems(query: "memory frag")` finds items by part of their name, ignoring case and accents, with prices in the same query.
- **One request, many items.** Ask for many items, regions and price histories at once; Agris batches the upstream calls.
- **Edge caching.** Each field has a freshness window (order books 5 s, prices 60 s, names a year), so repeated queries come from Cloudflare's cache.
- **Kind to Pearl Abyss.** Identical requests in flight share one upstream call, and a cap on concurrent calls queues the rest.
- **Yours.** Your account, your limits, your cache, your hostname. No API key and nobody else's traffic.

## 30-second example

Open `/graphql` on any Agris gateway in a browser for GraphiQL, or send a query from anywhere:

```graphql
query {
  searchItems(query: "memory frag", locale: EN, first: 1) {
    items {
      id
      name
      marketSummary(region: EU) {
        basePrice
        currentStock
      }
    }
  }
}
```

```json
{
  "data": {
    "searchItems": {
      "items": [
        { "id": "44195", "name": "Memory Fragment", "marketSummary": { "basePrice": 2450000, "currentStock": 70598 } }
      ]
    }
  }
}
```

(The demo's answer on 12 October 2026; prices move.) Same thing with curl:

```sh
curl https://<your-host>/graphql -H 'content-type: application/json' \
  -d '{"query":"{ market(region: EU) { items(ids: [\"44195\", \"16001\"]) { item { name } basePrice } } }"}'
```

## How it works

```text
client ──HTTPS──▶ agris (gateway: validate, rate limit, edge cache, federate)
                    ├─ Service Binding ─▶ agris-catalog   names in 12 languages + search, in memory
                    └─ Service Binding ─▶ agris-market ──▶ Pearl Abyss Central Market (12 regions)
                                           └─ one Durable Object per upstream host coordinates calls
```

Only the gateway is public. More in [docs/architecture.md](docs/architecture.md).

## Deploy your own

You need a Cloudflare account on the **Workers Paid** plan, plus `git` and `curl`.

```sh
curl -fsSL https://moonrepo.dev/install/proto.sh | bash   # installs the pinned Node.js, pnpm and moon
git clone https://github.com/Hebilicious/agris.git && cd agris
proto install && pnpm install
pnpm --filter @agris/gateway-worker exec cf auth login    # or export CLOUDFLARE_API_TOKEN
moon run gateway:deploy                                    # agris-market, agris-catalog, then agris
curl https://agris.<your-subdomain>.workers.dev/health          # or your own hostname
```

The gateway starts on `workers.dev` because that needs no setup. Any hostname works: a custom domain or a route on any zone in your account. See [docs/deploy.md](docs/deploy.md#hostnames).

Why not the free plan? [docs/free-plan.md](docs/free-plan.md) explains the limits involved and why the catalog lives in memory.

The [shared demo](https://agris-demo.hebilicious.workers.dev) is for looking around (10 requests per minute per IP), not for building on.

## Configuration

Settings live in each Worker's `cloudflare.config.ts` (gateway: `workers/gateway/`, market: `workers/market/`, catalog: `workers/catalog/`). Edit the `production` mode, then run `moon run gateway:deploy` again. The full table with every mode is in [docs/deploy.md](docs/deploy.md#configuration).

| Setting                           | File            | Default                                  | What it does                                                                                     |
| --------------------------------- | --------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Worker `name`                     | all three       | `agris`, `agris-market`, `agris-catalog` | The gateway binds the subgraphs by name, so rename them together.                                |
| `workersDev`                      | gateway         | `true`                                   | Serves the gateway on `agris.<subdomain>.workers.dev`. Set `false` to drop that URL.             |
| `domains`, `triggers`             | gateway         | none                                     | Custom domains, or routes (`triggers.fetch({ pattern, zone })`), on any zone in your account.    |
| Account                           | credentials     | none                                     | `cf auth login`, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Never in the repository. |
| `CLIENT_RATE_LIMITER`             | gateway         | 60 per 60 s per IP, namespace `42010`    | Per-client limit on `/graphql`.                                                                  |
| `GLOBAL_RATE_LIMITER`             | gateway         | not set                                  | One limit for the whole deployment, counted per Cloudflare location.                             |
| `GRAPHIQL`                        | gateway         | on                                       | GraphiQL at `/graphql` in a browser. Set it to `"disabled"` to turn it off.                      |
| `MARKET_CACHE_MIN_TTL_SECONDS`    | gateway         | not set                                  | Raises every cacheable answer's freshness to at least this many seconds.                         |
| `DEMO_NOTICE`, `DEPLOY_GUIDE_URL` | gateway         | not set                                  | An `X-Agris-Demo` header on every response, and a link in `429` messages.                        |
| `PA_MAX_CONCURRENT_REQUESTS`      | market          | `6`                                      | Concurrent Pearl Abyss calls per upstream host.                                                  |
| `PA_RATE_LIMITER`                 | market          | 100 per 10 s, namespace `42003`          | Burst backstop on Pearl Abyss calls.                                                             |
| `limits.subrequests`              | gateway, market | `1000`                                   | Subrequests per invocation; the gateway's request budget uses the same number.                   |
| `observability`                   | all three       | logs 100%, traces 5%                     | Workers Logs and traces sampling.                                                                |

Rate-limit `namespace` IDs are shared by every Worker in an account. If yours already uses `42003` or `42010`, pick unused numbers.

## Limits

Queries only, one operation per request, bodies up to 64 KiB, responses up to 1 MiB, and depth, alias and field limits per document. `searchItems` needs at least 3 characters. Details in [docs/api.md](docs/api.md#limits).

## Develop

```sh
moon run agris:dev     # gateway on :8790, market Worker on :8791
moon run site:dev      # website on :4321
moon run agris:check   # format, lint, types, tests, artifacts, site build, bundles
```

[CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) cover the layout and conventions.

## Credits

[Arsha](https://github.com/guy0090/api.arsha.io) (api.arsha.io, by guy0090): its open-source Central Market API was the reference for the Pearl Abyss endpoints, request shapes and response fields Agris uses. Thank you.

The website's Fig 1, the request path drawn as a machine, is built with [anatomy](https://github.com/wheresryan22/anatomy) by Ryan (MIT), vendored in `site/vendor/anatomy`.

## Disclaimer

Agris is an unofficial community project, not affiliated with, endorsed by, or sponsored by Pearl Abyss or Arsha. Black Desert and Black Desert Online are trademarks of Pearl Abyss. Use the market data responsibly. Provided as is, under the [MIT license](LICENSE).
