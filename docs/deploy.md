# Deploying Agris

Deploying your own copy is the supported way to use Agris. This guide takes a Cloudflare account to a working gateway, then covers hostnames, every setting, rate limiting, extending the gateway, and cost.

## What gets deployed

Agris deploys with [Alchemy](https://alchemy.run): `infra/alchemy.run.ts` is one stack, and the stage you deploy names what it creates. `moon run agris:deploy` deploys the `production` stage, four Workers:

| Worker          | Role                                                | Reachable from the internet                    |
| --------------- | --------------------------------------------------- | ---------------------------------------------- |
| `agris`         | Public gateway: GraphQL, GraphiQL and `/health`     | Yes, on `workers.dev` and any hostname you add |
| `agris-cache`   | The gateway's edge-cached execution (Workers Cache) | No                                             |
| `agris-market`  | Market subgraph and its Pearl Abyss coordinators    | No                                             |
| `agris-catalog` | Catalog subgraph                                    | No                                             |

Any other stage name deploys the same four Workers as `agris-<stage>`, `agris-<stage>-cache` and so on, so you can run several copies in one account. Two stages belong to the maintainer: `demo` (the shared API, `agris-demo`) and `docs` (the website, `agris-docs`).

Nothing about your account is stored in the repository. The account comes from `CLOUDFLARE_ACCOUNT_ID` when you deploy, and Alchemy keeps the stack's state in a state-store Worker it creates in your account, so every machine you deploy from sees the same deployment.

## Prerequisites

- A Cloudflare account. Agris deploys on the Workers Free plan with the default settings; on a paid plan you can raise `SUBREQUEST_LIMIT`. Cloudflare lists each plan's limits on [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
- `git` and `curl`. Everything else comes from proto.

## Step by step

### 1. Toolchain

[proto](https://moonrepo.dev/proto) installs the exact Node.js, pnpm and moon versions pinned in `.prototools`.

```sh
curl -fsSLO https://github.com/moonrepo/proto/releases/download/v0.63.1/proto_cli-installer.sh
echo "e33cc6e6e1834ac3d769e311415b4a12013ae33fe2b27cdcf34340a62d97c2b6  proto_cli-installer.sh" | sha256sum -c
PROTO_HOME="$HOME/.proto" PROTO_CLI_NO_MODIFY_PATH=1 sh proto_cli-installer.sh
~/.proto/bin/proto setup
```

The installer is proto's own, from the release `.prototools` pins (`proto = "0.63.1"`): it is saved to a file you can read before running it, its own SHA-256 is checked against the one GitHub publishes for that release before it runs (on a Mac without `sha256sum`, use `shasum -a 256 -c`), and it checks the SHA-256 of the proto build it downloads. `PROTO_HOME` makes it install into `~/.proto` even when your shell sets `PROTO_HOME` or `XDG_DATA_HOME`, so `~/.proto/bin/proto` is where it put proto. `proto setup` adds proto and its shims to your shell profile. Open a new shell so `proto`, `pnpm` and `moon` are on your `PATH`, then:

```sh
git clone https://github.com/Hebilicious/agris.git
cd agris
proto install
pnpm install
```

### 2. Credentials

Create an API token from the **Edit Cloudflare Workers** template, and export it with your account ID (the dashboard shows it on **Workers & Pages**):

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
```

Or sign in once with OAuth instead of a token: `pnpm --filter @agris/infra exec alchemy profile edit --add Cloudflare`. Keep both out of the repository.

### 3. Optional: check before you deploy

```sh
moon run infra:plan      # what the deploy would create, change or delete (reads your account)
moon run agris:bundle    # bundle the four Workers without an account
moon run agris:check     # everything a change must pass
```

### 4. Deploy

```sh
moon run agris:deploy
```

Settings are environment variables of this command; with none set you get the defaults below. For example, `CACHE_MINIMUM_SECONDS=600 GLOBAL_RATE_LIMIT_REQUESTS=300 moon run agris:deploy`. A setting Agris does not know, or a value it cannot use, stops the deploy before anything is uploaded. Set them again on every deploy: a deploy replaces every binding.

### 5. Verify

```sh
HOST=agris.<your-subdomain>.workers.dev   # or your own hostname
curl -i "https://$HOST/health"
curl "https://$HOST/graphql" -H 'content-type: application/json' \
  -d '{"query":"{ market(region: EU) { observedAt items(ids: [\"44195\"]) { item { name } basePrice } } }"}'
```

`/health` should answer `200`, and the query should return a name and a price. A `503` means the market Worker could not reach Pearl Abyss; try another region or wait. Open `https://$HOST/graphql` in a browser for GraphiQL.

## Updating

```sh
git pull
pnpm install
moon run agris:deploy    # with the same settings as before
```

Deploys replace Worker versions in place. The cache Worker's answers are scoped to its version, so a deploy starts with a cold cache.

`moon run infra:destroy` deletes the `production` stage's Workers.

## Hostnames

The gateway answers on `agris.<your-subdomain>.workers.dev` out of the box because that needs no DNS setup. It is only a default. Any hostname on a zone in your Cloudflare account works the same way.

- **Custom domain.** `AGRIS_DOMAIN=market.example.com moon run agris:deploy` makes the gateway the origin for that hostname; Cloudflare creates the DNS record and certificate ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)). The zone must be in the same account.
- **No public `workers.dev` URL.** Add `AGRIS_WORKERS_DEV=false` once a custom domain is in place. Cloudflare recommends a custom domain for production traffic ([workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)).
- **A route on a hostname that serves something else**, such as `example.com/graphql*`: add `routes: [{ pattern: "example.com/graphql*", zoneName: "example.com" }]` to `gatewayProps` in `infra/src/gateway/props.ts` ([Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)). The gateway serves `/graphql` and `/health`; a route must cover the paths you want to reach.
- **Private only.** Set `AGRIS_WORKERS_DEV=false` and no domain; only Service Bindings from your own Workers reach the gateway. See [architecture.md](architecture.md#embedding-agris-in-your-cloudflare-app).

## Configuration

Every setting is one environment variable of the deploy command, and every limit can be turned off. Unset keeps the default. The demo column shows the maintainer's shared demo (fixed in `infra/src/settings.ts`, whatever the environment holds). The README groups the same variables by what they control.

### Rate limits

The gateway has two kinds of limit, one cheap and approximate, the other exact and paid for only by work that would read the Central Market.

- **The rate-limit bindings**, `CLIENT_RATE_LIMIT_*` and `GLOBAL_RATE_LIMIT_*`, are [Workers rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). Every request to the public gateway passes them before it is routed, so `/health`, CORS preflights and GraphiQL spend the same allowance as queries. They count at the Cloudflare location that runs the request, so they add no round trip, but they are approximate: a parallel burst, or a client whose requests land on several locations, gets more than the figure before the counters converge.
- **The exact market limit**, `MARKET_CLIENT_LIMIT_*`, is a token bucket per client, kept by a `GatewayAdmission` Durable Object: one instance worldwide that answers its requests one at a time, so a burst gets exactly the limit and no more. Only a query about to read the Central Market asks it, once per query, just before its first market call: a cache hit, a catalog-only query, a health check, a preflight and GraphiQL never do. A refusal is reported as the market's own throttle, so the caller gets the stale cached answer when the edge keeps one, and otherwise `429` with a `RATE_LIMITED` error and a `Retry-After` of the seconds until the bucket refills one request.

A limit of `0` turns it off, and the gateway then limits nothing there. The client binding is on by default, at 60 requests a minute: a self-hosted gateway answers anyone on `workers.dev`, with CORS open to every origin, from the moment it deploys, and the binding costs no round trip. The global binding and the exact market limit are off by default; the Pearl Abyss limits below protect the upstream whoever is asking. Turn the exact market limit on with `MARKET_CLIENT_LIMIT_REQUESTS` to keep one client, however it bursts, from spending a region's Pearl Abyss limit; it costs one Durable Object request for each query that misses the cache and reads the market.

| Variable                             | Default | Demo    | Off | What it does                                                                                                                                      |
| ------------------------------------ | ------- | ------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLIENT_RATE_LIMIT_REQUESTS`         | `60`    | `10`    | `0` | Requests per period per client, keyed by `CF-Connecting-IP`, an IPv6 address by its /64, per Cloudflare location. Checked first.                  |
| `CLIENT_RATE_LIMIT_PERIOD_SECONDS`   | `60`    | `60`    |     | `10` or `60`.                                                                                                                                     |
| `CLIENT_RATE_LIMIT_NAMESPACE_ID`     | `42010` | `42021` |     | The account-wide namespace that holds the counters.                                                                                               |
| `GLOBAL_RATE_LIMIT_REQUESTS`         | `0`     | `120`   | `0` | Requests per period for the whole deployment, under one key, per Cloudflare location.                                                             |
| `GLOBAL_RATE_LIMIT_PERIOD_SECONDS`   | `60`    | `60`    |     | `10` or `60`.                                                                                                                                     |
| `GLOBAL_RATE_LIMIT_NAMESPACE_ID`     | `42011` | `42022` |     | The account-wide namespace that holds the counters.                                                                                               |
| `MARKET_CLIENT_LIMIT_REQUESTS`       | `0`     | `10`    | `0` | Queries per period per client that read the Central Market because the edge cache had no fresh answer. Exact, whatever the location or the burst. |
| `MARKET_CLIENT_LIMIT_PERIOD_SECONDS` | `60`    | `60`    |     | Any whole number of seconds, 1 or more.                                                                                                           |

- **A per-IP limit is a courtesy control, not a bill cap.** It keeps one client from taking the whole deployment, but anyone with many addresses gets many allowances, and every refused request is still a billed Worker invocation. A global limit caps what the gateway executes, not what it is sent. The only private deployment is `AGRIS_WORKERS_DEV=false` with no domain, reached through Service Bindings from your own Workers.
- **What a client is.** The client key is the `CF-Connecting-IP` Cloudflare sets, an IPv6 address cut to its /64. Everyone behind one address shares one allowance: a company or carrier NAT, a VPN or relay exit (iCloud Private Relay, WARP and the like) that many people share, and every Worker on Cloudflare that calls your gateway over `fetch`, since Cloudflare's own egress addresses are what such a call arrives from, so Workers of different owners can share one /64 bucket. A Worker of yours should reach the gateway through a Service Binding instead, which is not admitted at all. A zone with [Pseudo IPv4](https://developers.cloudflare.com/network/pseudo-ipv4/) set to overwrite headers replaces an IPv6 caller's `CF-Connecting-IP` with a pseudo IPv4 address made from its IPv6 address, so the gateway keys that caller by the pseudo address instead of its /64, and the addresses of one /64 can each get their own allowance; on a custom domain, leave Pseudo IPv4 off or at "Add header".
- **A refused preflight is answered.** A browser cannot read a refused CORS preflight, so it would report a network error instead of the limit. A preflight spends the client's binding allowance like any request, but a refused one is answered `204` with `Access-Control-Max-Age: 0`, so the browser asks again next time and its real request gets the readable `429` and `Retry-After`.
- **The cache stays shared.** The client key reaches the execution behind the edge cache as a header of the cache key request, which Workers Cache does not key on; it does key on an invocation's `ctx.props`, which is why the key is not there. Every client is served the same stored answers.
- **Admission fails closed.** When a `GatewayAdmission` object cannot answer, as an overloaded object would under a flood, the query's market reads are refused as a throttle with `Retry-After: 5`, instead of admitting everyone.
- **What it costs.** A request the bindings refuse costs its invocation and nothing more. A cache hit, a catalog-only query, a health check, a preflight and GraphiQL make no Durable Object request. A query that reads the Central Market makes one, however many market calls it plans, and it reads and writes that client's stored bucket; it counts as one subrequest of the query's budget (`SUBREQUEST_LIMIT`). There is no deployment-wide object: the Pearl Abyss rate limit below already caps what the deployment sends each Pearl Abyss region, in effect exactly, and the global binding caps what it is sent, cheaply.
- **The buckets are stored.** Each object writes its bucket to its own storage on every decision, before it answers. An object the runtime evicts after an idle spell, or restarts with a deploy, carries on from the tokens it had, so an exhausted allowance stays exhausted until it refills. Changing a limit keeps the tokens a bucket has, up to the new limit, so raising a limit never hands a client a fresh allowance.

### Upstream (Pearl Abyss)

The market Worker reaches Pearl Abyss through one coordinator per upstream host: a Durable Object that sends each distinct request once, shares its answer with identical requests in flight, and queues the rest behind the concurrency limit. The concurrency limit applies to each host, so twelve hosts can run up to twelve times as many calls at once in all. The rate limit applies to each region too: each Pearl Abyss region is its own server, so each region's coordinator asks `PA_RATE_LIMITER` for a permit, counted for its own host alone, before a distinct call waits for a slot. One busy region never spends another's limit, and the deployment's total is twelve times the figure below: 1,200 calls per 10 seconds by default, 240 a minute on the demo.

| Variable                       | Default | Demo    | Off | What it does                                                                                                                     |
| ------------------------------ | ------- | ------- | --- | -------------------------------------------------------------------------------------------------------------------------------- |
| `PA_MAX_CONCURRENT_REQUESTS`   | `6`     | `2`     | `0` | Distinct Pearl Abyss calls at once, per upstream host; extra distinct work waits in order. `0` still runs at most 1,000 at once. |
| `PA_RATE_LIMIT_REQUESTS`       | `100`   | `20`    | `0` | Burst backstop on Pearl Abyss calls per period, per region (12 times this across every region). A denied call is not sent.       |
| `PA_RATE_LIMIT_PERIOD_SECONDS` | `10`    | `60`    |     | `10` or `60`.                                                                                                                    |
| `PA_RATE_LIMIT_NAMESPACE_ID`   | `42003` | `42020` |     | The account-wide namespace that holds the counters.                                                                              |

Turning both off removes Agris's own protection of Pearl Abyss's servers; the cache and the coalescing of identical calls remain.

### Subrequests

| Variable           | Default | Demo | What it does                                                                                                                                                         |
| ------------------ | ------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUBREQUEST_LIMIT` | `50`    | `50` | The gateway, cache and market Workers' `limits.subrequests`, and the budget one query spends within it: subgraph calls and Pearl Abyss requests together. 1 or more. |

The default works on the Workers Free plan; a paid plan lets you raise it ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)). A query that needs more than the budget gets a `QUERY_BUDGET_EXCEEDED` error for the fields it could not read, and keeps the rest of its answer. Market summaries are also limited to 6 distinct batches per query, or fewer when `SUBREQUEST_LIMIT` leaves less room. `0` is not accepted: every Worker needs subrequests.

**Where the coordinators run.** Each coordinator is created next to the Pearl Abyss server it calls. Pearl Abyss's hosts sit behind an anycast edge, so DNS does not show where a server is; the market Worker instead gives each region a Durable Object [location hint](https://developers.cloudflare.com/durable-objects/reference/data-location/#provide-a-location-hint) measured by timing every host from every hint (`PEARL_ABYSS_COORDINATOR_LOCATIONS` in `apps/market/src/market.ts`): `weur` for EU, MENA and RU, `wnam` for NA, `apac` for Asia, KR, JP and TW, `enam` for SA (Cloudflare has no South American location). It addresses each coordinator as `getByName("<hint>:<host>", { locationHint })`. Each coordinator consults `PA_RATE_LIMITER` itself, under a key that names its host, so regions that share a location (EU, MENA and RU in `weur`, for one) never share a count. Workers rate limits count per Cloudflare location, and a region has exactly one coordinator, at one location, so its count is in effect exact, and a permit costs no round trip. A hint applies only when an object is first created, so the hint is part of the name: changing one creates a coordinator in the new place instead of leaving the old one where it was.

### Cache

Each schema coordinate has a fresh window (`max-age`) and a stale-while-revalidate window, and a response takes the shortest of each among the fields it selects ([api.md](api.md#caching)). Every coordinate with a default has its own two variables, named `CACHE_<TYPE>_<FIELD>_MAX_AGE_SECONDS` and `CACHE_<TYPE>_<FIELD>_STALE_WHILE_REVALIDATE_SECONDS` (`Market.hotItems` is `CACHE_MARKET_HOT_ITEMS_…`). Every value is whole seconds and accepts `0`; a fresh window of `0` stores nothing that selects that field, whatever the floor.

| Variable                                                         | Default    | Demo  | Off     |
| ---------------------------------------------------------------- | ---------- | ----- | ------- |
| `CACHE_ENABLED`                                                  | `true`     |       | `false` |
| `CACHE_MINIMUM_SECONDS`                                          | `0`        | `600` | `0`     |
| `CACHE_STALE_IF_ERROR_SECONDS`                                   | `86400`    |       | `0`     |
| `CACHE_NEVER_STORED`                                             | empty      |       | empty   |
| `CACHE_MARKET_ITEMS_MAX_AGE_SECONDS`                             | `60`       |       | `0`     |
| `CACHE_MARKET_ITEMS_STALE_WHILE_REVALIDATE_SECONDS`              | `70`       |       | `0`     |
| `CACHE_ITEM_MARKET_SUMMARY_MAX_AGE_SECONDS`                      | `60`       |       | `0`     |
| `CACHE_ITEM_MARKET_SUMMARY_STALE_WHILE_REVALIDATE_SECONDS`       | `70`       |       | `0`     |
| `CACHE_MARKET_ITEM_LISTINGS_MAX_AGE_SECONDS`                     | `60`       |       | `0`     |
| `CACHE_MARKET_ITEM_LISTINGS_STALE_WHILE_REVALIDATE_SECONDS`      | `70`       |       | `0`     |
| `CACHE_MARKET_ITEM_ORDER_BOOK_MAX_AGE_SECONDS`                   | `5`        |       | `0`     |
| `CACHE_MARKET_ITEM_ORDER_BOOK_STALE_WHILE_REVALIDATE_SECONDS`    | `5`        |       | `0`     |
| `CACHE_MARKET_REGISTRATIONS_MAX_AGE_SECONDS`                     | `5`        |       | `0`     |
| `CACHE_MARKET_REGISTRATIONS_STALE_WHILE_REVALIDATE_SECONDS`      | `5`        |       | `0`     |
| `CACHE_MARKET_CATALOG_MAX_AGE_SECONDS`                           | `30`       |       | `0`     |
| `CACHE_MARKET_CATALOG_STALE_WHILE_REVALIDATE_SECONDS`            | `30`       |       | `0`     |
| `CACHE_MARKET_HOT_ITEMS_MAX_AGE_SECONDS`                         | `30`       |       | `0`     |
| `CACHE_MARKET_HOT_ITEMS_STALE_WHILE_REVALIDATE_SECONDS`          | `30`       |       | `0`     |
| `CACHE_MARKET_ITEM_PRICE_HISTORY_MAX_AGE_SECONDS`                | `3600`     |       | `0`     |
| `CACHE_MARKET_ITEM_PRICE_HISTORY_STALE_WHILE_REVALIDATE_SECONDS` | `3600`     |       | `0`     |
| `CACHE_QUERY_ITEM_MAX_AGE_SECONDS`                               | `31536000` |       | `0`     |
| `CACHE_QUERY_ITEM_STALE_WHILE_REVALIDATE_SECONDS`                | `86400`    |       | `0`     |
| `CACHE_QUERY_ITEMS_MAX_AGE_SECONDS`                              | `31536000` |       | `0`     |
| `CACHE_QUERY_ITEMS_STALE_WHILE_REVALIDATE_SECONDS`               | `86400`    |       | `0`     |
| `CACHE_QUERY_SEARCH_ITEMS_MAX_AGE_SECONDS`                       | `31536000` |       | `0`     |
| `CACHE_QUERY_SEARCH_ITEMS_STALE_WHILE_REVALIDATE_SECONDS`        | `86400`    |       | `0`     |

- `CACHE_ENABLED=false` stores nothing: every answer is `no-store` and no request reaches the cache Worker.
- `CACHE_MINIMUM_SECONDS` raises every storable answer's fresh and stale-while-revalidate windows to at least that many seconds. It never shortens a window and never makes an uncached field cacheable. The demo sets `600`.
- `CACHE_NEVER_STORED` is a comma-separated list of `Type.field` coordinates; selecting any of them makes the whole answer `no-store`. Empty, the default, stores every coordinate.
- `Item.marketSummary` takes the price window, so `items(ids:) { marketSummary(region:) { … } }` is cached for a minute even though `Query.items` keeps for a year. `Query.searchItems` answers from the catalog in this release, so it keeps for a year like `Query.item`; a deploy starts with a cold cache.
- With no `CACHE_` variable set, the gateway runs `DEFAULT_CACHE_FRESHNESS` from `@agris/core` exactly.

### Query limits

The public gateway's limits on one query, after fragments are expanded ([api.md](api.md#limits)). `0` lifts a limit, for GraphiQL's introspection queries too.

| Variable                    | Default | Demo  | Off | What it does                                                           |
| --------------------------- | ------- | ----- | --- | ---------------------------------------------------------------------- |
| `QUERY_MAX_DEPTH`           | `8`     | `8`   | `0` | The deepest chain of nested fields.                                    |
| `QUERY_MAX_FIELDS`          | `150`   | `150` | `0` | Every selected field, each fragment spread counted where it is spread. |
| `QUERY_MAX_ALIASES`         | `15`    | `15`  | `0` | Fields selected under an alias.                                        |
| `QUERY_MAX_TYPE_EXPANSIONS` | `2`     | `2`   | `0` | Type-listing introspection fields (`types`, `fields`, …) on one path.  |

### GraphiQL and the public surface

| Variable           | Default   | Demo                       | Off         | What it does                                                                 |
| ------------------ | --------- | -------------------------- | ----------- | ---------------------------------------------------------------------------- |
| `GRAPHIQL`         | `enabled` | `enabled`                  | `disabled`  | A browser opening `GET /graphql` with no query string gets GraphiQL.         |
| `DEPLOY_GUIDE_URL` | not set   | the website's deploy guide | leave unset | Appended to `429` messages, so a rate-limited caller learns where to deploy. |

The demo also sends an `X-Agris-Demo` notice on every response; it is not a self-hosted setting.

GraphiQL is Yoga's page, which loads GraphiQL's code from one pinned release on `unpkg.com`. That code runs on the gateway's own origin, so the page is served with a `Content-Security-Policy` that lets it run only its own inline scripts, by their hashes, and that release's `dist/` directory, connect only to the gateway and that release, and be framed by no site (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). It still trusts unpkg to serve that release unchanged. GraphiQL stays on by default so a new deployment can be explored in a browser; set `GRAPHIQL=disabled` when the gateway answers on a hostname that shares cookies or storage with an application of yours. Every public response carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` unless it states its own.

### Deployment

| Variable                | Default      | Demo         | What it does                                                  |
| ----------------------- | ------------ | ------------ | ------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | required     | maintainer's | The account to deploy into. Never in the repository.          |
| `CLOUDFLARE_API_TOKEN`  | or a profile | maintainer's | The token Alchemy signs in with, or an Alchemy OAuth profile. |
| `AGRIS_DOMAIN`          | not set      | not set      | A custom domain for the gateway, on a zone in the account.    |
| `AGRIS_WORKERS_DEV`     | `true`       | `true`       | `false` drops the gateway's `workers.dev` address.            |

The stage is the `--stage` argument; `moon run agris:deploy` passes `production`. To deploy another, run Alchemy yourself from `infra/`: `pnpm exec alchemy deploy alchemy.run.ts --stage eu`. Rate-limit namespaces are account-wide, so give a second stage its own `*_NAMESPACE_ID`s or it shares the first one's counters.

### Deploying the Workers' own entrypoints

The Workers' own entrypoints stay deployable without Alchemy, as a host that mounts Agris in its own repository does: re-export `@agris/gateway-worker` (`default`, `CachedAgrisProxy`, or `@agris/gateway-worker/public` for the public surface), `@agris/market-worker` (`default`, `BudgetedMarketSubgraph`, `PearlAbyssCoordinator`) and `@agris/catalog-worker` from your Worker modules, and bind them in your own configuration. The gateway reads the same `CACHE_*` and `QUERY_*` variables and `GRAPHIQL` as plain-text vars; `CLIENT_RATE_LIMITER`, `GLOBAL_RATE_LIMITER` and `PA_RATE_LIMITER` are optional rate-limit bindings. The exact market limit is the plain-text vars `MARKET_CLIENT_LIMIT_REQUESTS` and `MARKET_CLIENT_LIMIT_PERIOD_SECONDS` (absent or `0` requests: none; absent period: 60 seconds); setting it requires the `ADMISSION` Durable Object binding to the `GatewayAdmission` class that `@agris/gateway-worker/public` exports, added by a migration as a new SQLite class, and the gateway throws on every query without it, and `PA_MAX_CONCURRENT_REQUESTS` is an optional number (absent or `0`: no limit of its own, still capped at 1,000 at once with 100 waiting). Deploy the market Worker with the `enable_request_signal` compatibility flag, as the stack does, so a caller that gives up stops its queued Pearl Abyss read. The gateway and market Worker read an optional `SUBREQUEST_LIMIT` (absent: 50); if your configuration raises `limits.subrequests`, set `SUBREQUEST_LIMIT` on both to the same number. With none of them bound, the gateway behaves exactly as before these settings existed. The stack's `smoke` stage deploys them this way (`infra/src/smoke/`): `moon run smoke:smoke` deploys it and runs the cache smoke against it, and `moon run infra:smoke-destroy` deletes it.

## Rate limiting, and what it costs

Know what the rate-limit bindings do and do not do; the exact market limit is the `GatewayAdmission` buckets described under [Rate limits](#rate-limits):

- They run inside the Worker. Cloudflare describes them as "applied after your Worker starts", so a rejected request has already invoked the gateway.
- That invocation is billed. "Only requests that hit a Worker will count against your limits and your bill" ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/#fine-print)), and a `429` is a request that hit the Worker.
- They count per Cloudflare location: "For each unique key you pass to your rate limiting binding, there is a unique limit per Cloudflare location." A client spread across locations gets the limit in each.
- They are approximate: "permissive, eventually consistent, and intentionally designed to not be used as an accurate accounting system."
- Periods are 10 or 60 seconds.
- Namespace IDs are account-wide. Two bindings with the same ID share counters, even across Workers. Give every limiter its own ID.

### Block before the Worker with a WAF rule

On a custom domain or route, a [WAF rate-limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) runs in the zone's request phases, so a blocked request never starts the gateway. `workers.dev` hostnames have no zone of yours, so they cannot take one.

1. In the dashboard, open your zone, then **Security → WAF → Rate limiting rules**.
2. Match `URI Path equals /graphql`.
3. Count by IP and choose **Block**.

How many rules and which periods you get depends on the zone's plan. Keep the Worker's own limit as a second line, or set it to `0` once the WAF rule covers it.

## Extending the gateway with Envelop plugins

`apps/gateway/src/plugins.ts` exports `gatewayPlugins`, a list of [Envelop plugins](https://the-guild.dev/graphql/envelop/plugins), empty by default. Hive Gateway runs every plugin in it on each execution, after Agris's own subgraph fetch. A plugin can log or trace operations, add to the response's `extensions`, or refuse an operation:

```ts
export const gatewayPlugins: readonly GatewayPlugin[] = [
  {
    onExecute({ args }) {
      const startedAt = Date.now();
      return {
        onExecuteDone() {
          console.info({ operation: args.operationName ?? null, milliseconds: Date.now() - startedAt });
        },
      };
    },
  },
];
```

Plugins run where the gateway executes: on a cache miss, a refresh or an uncached operation. An answer served from the edge cache never reaches them, and the rate limits, query limits and validation have already run. To use a plugin package (`@envelop/*`, `@graphql-hive/*`), add its version to the `catalog:` in `pnpm-workspace.yaml` and to `apps/gateway/package.json`, then deploy.

## The maintainer's stages

- `moon run agris:demo-deploy` deploys the `demo` stage: `agris-demo` and its cache, market and catalog Workers, API only (GraphQL, GraphiQL and `/health`), with the limits in the demo columns above. Alchemy creates and owns all four Workers.
- `moon run agris:docs-deploy` builds the website and deploys the `docs` stage: `agris-docs`, an assets-only Worker serving `website/dist`. Cloudflare's asset layer answers every request, so no Worker code runs and static asset requests are free.

Neither is for forks: deploy your own stage instead.

## Cost

Check [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) for current numbers.

- **The Free plan.** Agris runs on it with the default settings; its daily request limit is on [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
- **Requests and CPU.** Every request to the gateway is a billed request, including ones it rejects with `429`. Calls over Service Bindings to the subgraphs add no request charge, but their CPU time counts ([Service bindings pricing](https://developers.cloudflare.com/workers/platform/pricing/#service-bindings)). The cache Worker has Workers Cache on, so each storable query counts as a request there too, whether the cache answers it or not ([Workers Cache pricing](https://developers.cloudflare.com/workers/cache/#pricing)).
- **Durable Objects.** Each Pearl Abyss call passes through a coordinator. Cached answers never reach it. With `MARKET_CLIENT_LIMIT_REQUESTS` on, a query that reads the Central Market also makes one admission request, which writes that client's stored bucket; cached answers and catalog-only queries make none (see [Rate limits](#rate-limits)).
- **The state store.** Alchemy's state-store Worker in your account handles a few requests per deploy.

To keep costs predictable:

- leave caching on and select only the fields you need; a query with `orderBook` is cached for 5 seconds;
- batch item IDs into one `Market.items(ids:)` call;
- put a WAF rule in front of a custom domain;
- watch **Workers & Pages → agris → Metrics** after you share the URL.
