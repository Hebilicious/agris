# API reference

Agris serves one GraphQL endpoint, `/graphql`, from the gateway Worker. Examples use `https://<your-host>`: your gateway's `workers.dev` address or any hostname you gave it.

The schema is [`tools/schema/artifacts/client-schema.graphql`](../tools/schema/artifacts/client-schema.graphql). An introspection result sits next to it as `client-schema.introspection.json`.

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
- **GraphiQL** is on by default: a browser that opens `/graphql`, or a `/graphql?query=` link, gets an interactive editor. Any other browser GET, such as a persisted `?id=`, gets the data like any other client. Set the gateway's `GRAPHIQL` binding to `"disabled"` to turn it off. Introspection-only queries, which GraphiQL sends, are exempt from the document limits below.

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

A persisted query is a named query document stored in [`persisted-operations.json`](../tools/schema/artifacts/persisted-operations.json) under the SHA-256 of its canonical text (the document printed by `graphql-js` with ignored characters stripped). Sending the ID instead of the document keeps URLs short and makes the request a cacheable GET.

```sh
curl -G https://<your-host>/graphql \
  --data-urlencode 'id=2e23b7343c2a4c210e1d83395e8c3fe2a393af63840cac8f4e58b3e79d9f87a6' \
  --data-urlencode 'variables={"region":"EU","ids":["44195"],"locale":"EN"}'
```

A GET takes exactly one of `query` or `id` (64 lowercase hex characters), plus optional `variables` (a JSON object) and `operationName`; any other parameter, or one given twice, is rejected with `400`. The repository ships one example operation, `MarketItemsWithCatalog`. To add your own, list it in `tools/schema/src/generate.ts`, run `moon run schema:generate`, and redeploy; `moon run schema:check` rejects a document whose hash does not match.

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

- `BAD_USER_INPUT` from the catalog: `searchItems` got a query shorter than 3 characters after folding, longer than the longest item name, or `first` outside 1 to 100, with no partial data; or `item(id:)` or `items(ids:)` got an item ID that is not a positive whole number. The message says which.
- `BAD_USER_INPUT` from the market: an item ID that is not a positive whole number, or an enhancement level outside 0 to 20. The message says which.
- `QUERY_BUDGET_EXCEEDED`: a market-summary batch asked for more than 100 distinct items, the request needed more than 6 distinct summary batches, or it needed more subgraph calls and Pearl Abyss requests than the deployment's subrequest budget (50 by default). The affected nullable fields are `null`; sibling data survives. Ask for fewer markets, items or categories in one query.
- `UPSTREAM_UNAVAILABLE`: Pearl Abyss could not be reached, did not answer in time, or sent an answer that could not be read, for this field. Other fields keep their data.
- `INTERNAL_SERVER_ERROR`: anything else went wrong in a subgraph. The message is always "The market subgraph could not answer this field." or "The catalog subgraph could not answer this field.": internal error text never leaves a subgraph.

Pearl Abyss returns one ambiguous answer for both "unknown item" and "no market data", so Agris reports both as `isListed: false`.

## Limits

| Limit                              | Value                                                        |
| ---------------------------------- | ------------------------------------------------------------ |
| Request body                       | 64 KiB                                                       |
| Response body                      | 1 MiB                                                        |
| Document depth                     | 8 levels of fields, fragments expanded                       |
| Fields per document                | 150, fragments expanded                                      |
| Aliases per document               | 15                                                           |
| Subrequests per request            | 50 (the invocation budget, `SUBREQUEST_LIMIT`)               |
| Items per summary batch            | 100 distinct                                                 |
| Summary batches per request        | 6 distinct                                                   |
| `searchItems.first`                | 1 to 100                                                     |
| Rate limit, self-hosted gateway    | none                                                         |
| Rate limit, shared demo            | 10 per minute per IP, 120 per minute per Cloudflare location |
| Pearl Abyss concurrency (per host) | 6 active requests, extra work queued                         |
| Pearl Abyss request timeout        | 30 seconds                                                   |

These are the defaults. A deployment can change or turn off the depth, field and alias limits (`QUERY_MAX_*`), turn on or change both rate limits, change the Pearl Abyss concurrency, and change the subrequest budget; [deploy.md](deploy.md#configuration) lists every setting.

## Caching

The gateway chooses a cache lifetime from the fields a query selects. Each schema coordinate has a freshness window, and the response takes the shortest one it touches. These are the defaults (`DEFAULT_CACHE_FRESHNESS` in `@agris/core`); a deployment can change any one of them with its own `CACHE_*` variable, described below and in [deploy.md](deploy.md#cache):

| Field                                                       | Fresh for | Then served stale while refreshing |
| ----------------------------------------------------------- | --------- | ---------------------------------- |
| `MarketItem.orderBook`, `Market.registrations`              | 5 s       | 5 s                                |
| `Market.items`, `Item.marketSummary`, `MarketItem.listings` | 60 s      | 70 s                               |
| `Market.catalog`, `Market.hotItems`                         | 30 s      | 30 s                               |
| `MarketItem.priceHistory`                                   | 1 h       | 1 h                                |
| `Query.item`, `Query.items`, `Query.searchItems`            | 1 year    | 1 day                              |

By default a cached answer stays usable for one more day if a refresh fails (`stale-if-error=86400`). A price nested under a catalog field takes the price window: `items(ids:) { marketSummary(region:) { basePrice } }` keeps for a minute. Queries that select none of the fields above, and responses containing errors, are not stored. The cache key is built from the canonical document and canonical variables, so whitespace, key order and equivalent forms of the same query share one entry.

The gateway's cache settings are plain-text variables, one per value, and every one is optional:

- `CACHE_<TYPE>_<FIELD>_MAX_AGE_SECONDS` and `CACHE_<TYPE>_<FIELD>_STALE_WHILE_REVALIDATE_SECONDS` set one window value of a field in the table above, such as `CACHE_MARKET_ITEMS_MAX_AGE_SECONDS` for `Market.items`. A fresh window of `0` stores nothing that selects the field.
- `CACHE_STALE_IF_ERROR_SECONDS` replaces the one-day `stale-if-error` window.
- `CACHE_NEVER_STORED` replaces the comma-separated list of coordinates that are never stored; empty stores all of them.
- `CACHE_MINIMUM_SECONDS` raises every window to at least that many seconds. It never shortens a longer window and never makes an uncached query cacheable.
- `CACHE_ENABLED=false` stores nothing at all.

Every number is a whole number of seconds, zero or more, and every never-stored coordinate a field of the client schema. The gateway refuses any other value, and any `CACHE_` variable it does not know, with an error instead of falling back to the defaults.

The shared demo sets `CACHE_MINIMUM_SECONDS=600`, so every window in this table is at least 10 minutes there. Its market Worker also runs at most 2 Pearl Abyss requests at once and at most 20 per minute.

Headers that describe caching:

| Header                     | Values                                                                         |
| -------------------------- | ------------------------------------------------------------------------------ |
| `Cache-Control`            | `public, max-age=N, stale-while-revalidate=N, stale-if-error=N`, or `no-store` |
| `X-Central-Market-Source`  | `live`, `cache-fresh` or `cache-stale`                                         |
| `X-Central-Market-Refresh` | `not-attempted`, `in-background`, `succeeded` or `failed`                      |
| `Age`                      | Seconds since the cached answer was stored, when it came from cache            |
| `Cf-Cache-Status`          | Cloudflare's cache status (`HIT`, `MISS`, `STALE`, ...)                        |
| `X-Agris-Demo`             | Present only on the shared demo                                                |
