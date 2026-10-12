# API reference

Agris serves one GraphQL endpoint, `/graphql`, from the gateway Worker. Examples use `https://<your-host>`: your gateway's `workers.dev` address or any hostname you gave it.

The schema is [`tools/graph/artifacts/client-schema.graphql`](../tools/graph/artifacts/client-schema.graphql). An introspection result sits next to it as `client-schema.introspection.json`.

## Requests

| Form          | Example                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------- |
| POST          | `POST /graphql` with a JSON body `{"query": "...", "variables": {...}, "operationName": "..."}` |
| GET           | `GET /graphql?query=<url-encoded query>&variables=<url-encoded JSON>`                           |
| Persisted GET | `GET /graphql?id=<sha256>&variables=<url-encoded JSON>`                                         |
| Health        | `GET /health`                                                                                   |
| GraphiQL      | Open `/graphql` in a browser; `/graphql?query=<url-encoded query>` opens it on that query       |

Rules every request follows:

- **Queries only.** Mutations and subscriptions are rejected with `400`.
- **One operation per document.** Fragments are allowed. If `operationName` is given, it must match the operation's name.
- **POST bodies** must be `Content-Type: application/json` (an optional `charset=utf-8` is accepted), contain one JSON object, and use only the keys `query`, `variables`, `operationName` and `extensions` (a JSON object, accepted and ignored, as GraphiQL sends it). A POST must not carry query-string parameters. Batched arrays are rejected.
- **`variables`** must be a JSON object and must satisfy the operation's variable types.
- **CORS** is open (`Access-Control-Allow-Origin: *`), so a browser page on any origin can call your gateway.
- **GraphiQL** is on by default: a browser that opens `/graphql` gets an interactive editor. Set the gateway's `GRAPHIQL` binding to `"disabled"` to turn it off. Introspection-only queries, which GraphiQL sends, are exempt from the document limits below.

### POST

```sh
curl https://<your-host>/graphql \
  -H 'content-type: application/json' \
  -d '{
    "query": "query Names($ids: [ID!]!) { items(ids: $ids, locale: FR) { id name grade } }",
    "variables": { "ids": ["44195", "10006"] }
  }'
```

### Persisted queries

A persisted query is a named query document stored in [`persisted-operations.json`](../tools/graph/artifacts/persisted-operations.json) under the SHA-256 of its canonical text (the document printed by `graphql-js` with ignored characters stripped). Sending the ID instead of the document keeps URLs short and makes the request a cacheable GET.

```sh
curl -G https://<your-host>/graphql \
  --data-urlencode 'id=2e23b7343c2a4c210e1d83395e8c3fe2a393af63840cac8f4e58b3e79d9f87a6' \
  --data-urlencode 'variables={"region":"EU","ids":["44195"],"locale":"EN"}'
```

A GET takes exactly one of `query` or `id` (64 lowercase hex characters), plus optional `variables` (a JSON object) and `operationName`; any other parameter, or one given twice, is rejected with `400`. The repository ships one example operation, `MarketItemsWithCatalog`. To add your own, list it in `tools/graph/src/generate.ts`, run `moon run graph:generate`, and redeploy; `moon run graph:check` rejects a document whose hash does not match.

## Schema overview

```graphql
type Query {
  item(id: ID!, locale: ItemLocale! = EN): Item
  items(ids: [ID!]!, locale: ItemLocale! = EN): [Item!]!
  searchItems(query: String!, locale: ItemLocale!, first: Int! = 50): ItemSearchResult!
  market(region: MarketRegion!, locale: ItemLocale! = EN): Market!
}
```

- **`Item`** is the catalog entity: `id`, `locale`, `name`, `grade`, and `marketSummary(region:)` for a quick price in any region. `name` and `grade` are `null` for an ID the catalog does not know.
- **`items`** keeps the order of the IDs you pass, including duplicates and unknown IDs.
- **`searchItems`** finds every item whose name in `locale` contains the query. Matching ignores case, Latin accents, whitespace and punctuation (`blackstone` finds "Black Stone", `epee` finds "Épée"); it does not correct typos. Results are ordered exact match, then prefix, then other matches. `totalCount` counts every match; `first` (1 to 100) limits what is returned.
- **`Market`** is one region seen in one name locale:
  - `items(ids:)`: summary facts for the given items, in your order. An item with no market data comes back with `isListed: false` and `null` numbers.
  - `catalog(category:)`: everything listed in a category (`{ main, sub }`).
  - `hotItems`: items whose price is moving, with direction and amount.
  - `registrations`: the queue of items waiting to be listed.
  - `observedAt`: when the market data was read.
- **`MarketItem`** adds per-item detail fields, each of which costs one Pearl Abyss request per item: `listings` (enhancement bands with price limits and last sale), `orderBook(enhancementLevel:)`, `priceHistory(enhancementLevel:)` (90 points, `offsetFromLatest` 0 is the newest).
- **`SafeInteger`** carries prices, stock and trade counts. Prices exceed 32-bit integers, so this scalar accepts any non-negative integer up to `Number.MAX_SAFE_INTEGER`.

Regions: `EU`, `NA`, `ASIA` (the combined SEA and TH market), `MENA`, `KR`, `RU`, `JP`, `TW`, `SA`, `CONSOLE_EU`, `CONSOLE_NA`, `CONSOLE_ASIA`.

Locales: `EN`, `DE`, `FR`, `ES` (Latin American Spanish), `ES_EU`, `PT`, `RU`, `TR`, `JA`, `KO`, `TH`, `ZH_TW`. Region and locale are independent: you can read NA prices with Korean names.

## Responses and errors

Responses use `Content-Type: application/graphql-response+json; charset=utf-8`.

| Status | Meaning                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------- |
| `200`  | The query ran. The body may still contain `errors` next to partial `data`.                        |
| `400`  | Malformed JSON, invalid document, non-query operation, unknown persisted ID or invalid variables. |
| `404`  | A path other than `/graphql` or `/health`.                                                        |
| `405`  | An HTTP method the endpoint does not accept.                                                      |
| `415`  | A POST without `application/json`.                                                                |
| `429`  | Rate limited. Wait for the number of seconds in `Retry-After`.                                    |
| `502`  | The internal response exceeded the 1 MiB ceiling.                                                 |
| `503`  | Every subgraph call failed, usually because Pearl Abyss is unreachable. Not cached.               |

Request-level failures have a body of the form `{"errors":[{"message":"..."}]}` and `Cache-Control: no-store`.

Field-level errors carry a code in `extensions.code`:

- `BAD_USER_INPUT`: `searchItems` got a query shorter than 3 characters after folding, longer than the longest item name, or `first` outside 1 to 100. No partial data.
- `QUERY_BUDGET_EXCEEDED`: a market-summary batch asked for more than 100 distinct items, or the request needed more than 6 distinct summary batches. The affected nullable fields are `null`; sibling data survives.

Pearl Abyss returns one ambiguous answer for both "unknown item" and "no market data", so Agris reports both as `isListed: false`.

## Limits

| Limit                              | Value                                                        |
| ---------------------------------- | ------------------------------------------------------------ |
| Request body                       | 64 KiB                                                       |
| Response body                      | 1 MiB                                                        |
| Document depth                     | 8 levels of fields, fragments expanded                       |
| Fields per document                | 150, fragments expanded                                      |
| Aliases per document               | 15                                                           |
| Subrequests per request            | 1,000 (the invocation budget)                                |
| Items per summary batch            | 100 distinct                                                 |
| Summary batches per request        | 6 distinct                                                   |
| `searchItems.first`                | 1 to 100                                                     |
| Rate limit, self-hosted gateway    | 60 requests per 60 seconds per IP                            |
| Rate limit, shared demo            | 10 per minute per IP, 120 per minute per Cloudflare location |
| Pearl Abyss concurrency (per host) | 6 active requests, extra work queued                         |
| Pearl Abyss request timeout        | 30 seconds                                                   |

## Caching

The gateway chooses a cache lifetime from the fields a query selects. Each schema coordinate has a freshness window, and the response takes the shortest one it touches:

| Field                                          | Fresh for | Then served stale while refreshing |
| ---------------------------------------------- | --------- | ---------------------------------- |
| `MarketItem.orderBook`, `Market.registrations` | 5 s       | 5 s                                |
| `Market.items`, `MarketItem.listings`          | 60 s      | 70 s                               |
| `Market.catalog`, `Market.hotItems`            | 30 s      | 30 s                               |
| `MarketItem.priceHistory`                      | 1 h       | 1 h                                |
| `Query.item`, `Query.items`                    | 1 year    | 1 day                              |

A cached answer stays usable for one more day if a refresh fails (`stale-if-error=86400`). Queries that select `searchItems` or `Item.marketSummary`, queries that select none of the fields above, and responses containing errors are not stored. The cache key is built from the canonical document and canonical variables, so whitespace, key order and equivalent forms of the same query share one entry.

The shared demo raises every window in this table to at least 10 minutes (`MARKET_CACHE_MIN_TTL_SECONDS=600`). It never shortens a longer window and never makes an uncached query cacheable. Its market Worker also runs at most 2 Pearl Abyss requests at once and at most 20 per minute.

Headers that describe caching:

| Header                     | Values                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `Cache-Control`            | `public, max-age=N, stale-while-revalidate=N, stale-if-error=86400`, or `no-store` |
| `X-Central-Market-Source`  | `live`, `cache-fresh` or `cache-stale`                                             |
| `X-Central-Market-Refresh` | `not-attempted`, `in-background`, `succeeded` or `failed`                          |
| `Age`                      | Seconds since the cached answer was stored, when it came from cache                |
| `Cf-Cache-Status`          | Cloudflare's cache status (`HIT`, `MISS`, `STALE`, ...)                            |
| `X-Agris-Demo`             | Present only on the shared demo                                                    |
