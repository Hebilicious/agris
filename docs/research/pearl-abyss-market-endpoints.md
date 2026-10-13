# Pearl Abyss Central Market endpoints

Research dates: August 2026. Pearl Abyss publishes no schema, limits or compatibility promise for these endpoints. Everything below is either a direct observation of a first-party response or behaviour read from [Arsha](https://github.com/guy0090/api.arsha.io) (api.arsha.io, by guy0090), audited at commit [`0d04e43`](https://github.com/guy0090/api.arsha.io/tree/0d04e43a75bb90983781ad4374e8dd06926c4552). Arsha's open-source source code was the reference for the endpoint list, request bodies and field positions Agris uses; this note would not exist without it.

Labels used below:

- **Observed**: a direct request to a Pearl Abyss host returned this. It shows behaviour on that date, not a contract.
- **Arsha**: what Arsha's current source does.

## Transport

Every call is an HTTP `POST` to `https://<region-host>/TradeMarket/<endpoint>` with `User-Agent: BlackDesert`, a JSON body, and `keyType: 0` in the body. Arsha builds the URL, header and body in one place ([transport](https://github.com/guy0090/api.arsha.io/blob/0d04e43a75bb90983781ad4374e8dd06926c4552/src/main/java/io/arsha/api/services/MarketRequestService.java#L47-L99)).

Uncompressed endpoints return `{"resultCode": 0, "resultMsg": "<rows>"}`. Rows are separated by `|`, fields by `-`, and a trailing `|` leaves an empty segment to ignore. Three endpoints return `application/octet-stream` instead: Huffman-compressed bytes that decode to the same row format. Arsha's endpoint enum marks which ones ([`MarketEndpoint`](https://github.com/guy0090/api.arsha.io/blob/0d04e43a75bb90983781ad4374e8dd06926c4552/src/main/java/io/arsha/api/data/market/common/MarketEndpoint.java#L8-L43)); Agris decodes them in `packages/pearl-abyss/src/protocol/huffman.ts`.

No row contains an item name, grade, icon or category label. Names come from a separate catalog, joined by item ID.

## The seven endpoints

| Endpoint                   | Body                                      | Response   | Fields per row (Arsha's names)                                                                                                        | Agris field                          |
| -------------------------- | ----------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `GetWorldMarketSearchList` | `{keyType, searchResult: "id1,id2,..."}`  | JSON       | `id`, `currentStock`, `basePrice`, `totalTrades`                                                                                      | `Market.items`, `Item.marketSummary` |
| `GetWorldMarketSubList`    | `{keyType, mainKey: <id>}`                | JSON       | `id`, `minEnhance`, `maxEnhance`, `basePrice`, `currentStock`, `totalTrades`, `priceMin`, `priceMax`, `lastSoldPrice`, `lastSoldTime` | `MarketItem.listings`                |
| `GetWorldMarketList`       | `{keyType, mainCategory, subCategory}`    | compressed | `id`, `currentStock`, `totalTrades`, `basePrice`                                                                                      | `Market.catalog`                     |
| `GetBiddingInfoList`       | `{keyType, mainKey: <id>, subKey: <enh>}` | compressed | `price`, `sellers`, `buyers`                                                                                                          | `MarketItem.orderBook`               |
| `GetMarketPriceInfo`       | `{keyType, mainKey: <id>, subKey: <enh>}` | JSON       | 90 hyphen-separated prices, newest last, no dates                                                                                     | `MarketItem.priceHistory`            |
| `GetWorldMarketHotList`    | `{keyType}`                               | compressed | the ten `SubList` fields plus `priceChangeDirection` and `priceChangeValue`                                                           | `Market.hotItems`                    |
| `GetWorldMarketWaitList`   | `{keyType}`                               | JSON       | `id`, `sid` (enhancement), `price`, `liveAt` (epoch seconds)                                                                          | `Market.registrations`               |

Notes per endpoint:

- **`GetWorldMarketSearchList` is an ID batch, not a text search.** One observed request with 99 distinct IDs returned 82 rows; IDs without market data were left out, and rows came back in a different order from the request. Agris sends up to 100 distinct IDs per call, joins by ID, and reports omitted IDs as unlisted. The real upper bound is unknown.
- **`GetWorldMarketSubList` takes one ID.** There is no observed multi-ID form, so `listings` costs one call per item. One row can cover a range of enhancement levels (for example `0-7`, `8-10`).
- **Price history has no timestamps.** Arsha assigns one UTC day per value counting back from today; that is Arsha's projection, not something the endpoint states. Agris exposes `offsetFromLatest` instead of inventing dates.
- **The wait list is volatile.** Arsha deliberately does not cache it. Agris caches it for 5 seconds.

Prices exceed 32-bit integers (an observed `priceMax` was 7,600,000,000), so Agris uses a `SafeInteger` scalar for prices, stock and counts.

## An example row

Observed on the NA host:

```http
POST https://na-trade.naeu.playblackdesert.com/Trademarket/GetWorldMarketSubList
Content-Type: application/json
User-Agent: BlackDesert

{"keyType":0,"mainKey":44195}
```

```json
{ "resultCode": 0, "resultMsg": "44195-0-0-1680000-43483-708081197-75000-5000000-1670000-1787364852|" }
```

That is item 44195, enhancement 0 to 0, base price 1,680,000, stock 43,483, 708,081,197 trades, price limits 75,000 to 5,000,000, last sold for 1,670,000 at Unix time 1787364852.

An invalid ID returns `{"resultCode":0,"resultMsg":"0"}`, the same answer as a valid item with no market data. Arsha notes the same ambiguity ([`MarketService`](https://github.com/guy0090/api.arsha.io/blob/0d04e43a75bb90983781ad4374e8dd06926c4552/src/main/java/io/arsha/api/services/MarketService.java#L163-L176)). Agris therefore never claims "not found"; it reports `isListed: false`.

## Regions

| Agris region   | Host                                            |
| -------------- | ----------------------------------------------- |
| `EU`           | `eu-trade.naeu.playblackdesert.com`             |
| `NA`           | `na-trade.naeu.playblackdesert.com`             |
| `ASIA`         | `asia-trade.blackdesert.pearlabyss.com`         |
| `MENA`         | `tr-trade.blackdesert.pearlabyss.com`           |
| `KR`           | `trade.kr.playblackdesert.com`                  |
| `RU`           | `trade.ru.playblackdesert.com`                  |
| `JP`           | `trade.jp.playblackdesert.com`                  |
| `TW`           | `trade.tw.playblackdesert.com`                  |
| `SA`           | `trade.sa.playblackdesert.com`                  |
| `CONSOLE_EU`   | `console-eu-trade.blackdesert.pearlabyss.com`   |
| `CONSOLE_NA`   | `console-na-trade.blackdesert.pearlabyss.com`   |
| `CONSOLE_ASIA` | `console-asia-trade.blackdesert.pearlabyss.com` |

- `ASIA` is one market for SEA and TH; both resolve to the same host.
- The MENA host in Arsha's configuration, `trade.mena.playblackdesert.com`, did not resolve when checked. `trade.tr.playblackdesert.com` redirected to `tr-trade.blackdesert.pearlabyss.com`, which answered correctly, so Agris uses that.
- Arsha also supports Global Lab (`trade.global-lab.playblackdesert.com`). Agris leaves it out because its responses were not verified to match the live regions.

## Concurrency and politeness

Pearl Abyss publishes no rate or concurrency limit. Agris's defaults:

- **6 concurrent requests per host.** It fits Cloudflare's six simultaneous outbound connections per invocation and sits close to Arsha's effective default of five connections per route from its HTTP client pool. `PA_MAX_CONCURRENT_REQUESTS` changes it without a code change.
- **Identical in-flight requests share one fetch**, and distinct requests queue in FIFO order, inside one Durable Object per host. With 50 distinct requests and none settled, 6 run and 44 wait.
- **A burst limit of 100 requests per 10 seconds** as a backstop, not as the main control.
- **No retries.** A timed-out request fails; the gateway's cache can still serve the previous answer.
- **Edge caching** means most traffic never reaches Pearl Abyss at all.

If you run Agris, lower the concurrency before raising anything else when upstream timeouts appear.

## Open questions

Because nothing is documented, these remain unknown:

- the largest `searchResult` list the batch endpoint accepts (99 IDs is only a lower bound);
- whether a missing batch row means an invalid ID, an unlisted item, or something else;
- the exact meaning of base price, the price limits, total trades and hot-list membership;
- rate limits, uptime, and whether the format will change without notice;
- whether every regional host exposes identical behaviour.

Agris treats any unexpected row shape as invalid upstream data and fails that request instead of guessing.
