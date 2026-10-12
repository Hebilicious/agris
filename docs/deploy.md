# Deploying Agris

Deploying your own copy is the supported way to use Agris. This guide takes a Cloudflare account to a working gateway, then covers hostnames, rate limiting, every setting, and cost.

## What gets deployed

`moon run gateway:deploy` (or `moon run agris:deploy`) deploys three Workers in `production` mode, in dependency order:

| Worker          | Role                                   | Reachable from the internet                    |
| --------------- | -------------------------------------- | ---------------------------------------------- |
| `agris-market`  | Market subgraph and its Durable Object | No                                             |
| `agris-catalog` | Catalog subgraph                       | No                                             |
| `agris`         | Gateway                                | Yes, on `workers.dev` and any hostname you add |

The gateway binds the two subgraphs by Worker name, so they deploy first. No account ID is stored in the repository: `cf` deploys to the account your credentials select.

## Prerequisites

- A Cloudflare account on the **Workers Paid** plan. The gateway and market Worker set `limits.subrequests` to 1,000 per invocation; the free plan's maximum is 50 ([Wrangler configuration: limits](https://developers.cloudflare.com/workers/wrangler/configuration/#limits)). The free plan also allows 10 ms of CPU per request ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)). [free-plan.md](free-plan.md) explains the details and proposes a free-plan design.
- `git` and `curl`. Everything else comes from proto.

## Step by step

### 1. Toolchain

[proto](https://moonrepo.dev/proto) installs the exact Node.js, pnpm and moon versions pinned in `.prototools`.

```sh
curl -fsSL https://moonrepo.dev/install/proto.sh | bash
git clone https://github.com/Hebilicious/agris.git
cd agris
proto install
pnpm install
```

Open a new shell after installing proto so `proto`, `pnpm` and `moon` are on your `PATH`.

### 2. Credentials

Agris deploys with Cloudflare's `cf` CLI. Sign in interactively:

```sh
pnpm --filter @agris/gateway-worker exec cf auth login
pnpm --filter @agris/gateway-worker exec cf auth whoami
```

For CI or a headless machine, create an API token from the **Edit Cloudflare Workers** template and export it instead:

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...   # only needed if the token can reach several accounts
```

Keep both out of the repository.

### 3. Optional: check before you deploy

```sh
moon run agris:dry-run   # bundle the three Workers without uploading
moon run agris:check     # everything a change must pass
```

### 4. Deploy

```sh
moon run gateway:deploy
```

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
moon run gateway:deploy
```

Deploys replace Worker versions in place. Cached responses survive a deploy until they expire.

## Hostnames

The gateway answers on `agris.<your-subdomain>.workers.dev` out of the box because that needs no DNS setup. It is only a default. Any hostname on a zone in your Cloudflare account works the same way, and you can use several at once. Everything is configured on `productionWorker` in `workers/gateway/cloudflare.config.ts`.

**Custom domain.** The Worker becomes the origin for a whole hostname; Cloudflare creates the DNS record and certificate ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)).

```ts
export const productionWorker = defineWorker({
  ...publicSettings,
  name: "agris",
  domains: ["market.example.com"],
  env: {/* unchanged */},
});
```

**Route.** The Worker answers part of a hostname that already serves something else, such as `example.com/graphql*` ([Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)). Import `triggers` from `cf/config` beside `defineWorker`:

```ts
triggers: [triggers.fetch({ pattern: "example.com/graphql*", zone: "example.com" })],
```

The gateway serves `/graphql` and `/health`; a route must cover both paths you want to reach.

**No public `workers.dev` URL.** Set `workersDev: false` once a custom domain or route is in place. Cloudflare recommends a route or custom domain for production traffic ([workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)).

**Private only.** Remove the hostnames and set `workersDev: false`; only Service Bindings from your own Workers reach the gateway. See [architecture.md](architecture.md#embedding-agris-in-your-cloudflare-app).

Deploy again after any change.

## Rate limiting

The gateway's limits are [Workers rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). Know what they do and do not do:

- They run inside the Worker. Cloudflare describes them as "applied after your Worker starts", so a rejected request has already invoked the gateway.
- That invocation is billed. "Only requests that hit a Worker will count against your limits and your bill" ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/#fine-print)), and a `429` is a request that hit the Worker.
- They count per Cloudflare location: "For each unique key you pass to your rate limiting binding, there is a unique limit per Cloudflare location." A client spread across locations gets the limit in each.
- They are approximate: "permissive, eventually consistent, and intentionally designed to not be used as an accurate accounting system."
- Periods are 10 or 60 seconds.
- `namespace` IDs are account-wide. Two bindings with the same ID share counters, even across Workers. Give every limiter its own ID.

Static assets are different: "Requests to static assets are free and unlimited" ([static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)) and do not invoke the Worker unless `runWorkerFirst` matches them. The demo serves its website this way.

### Block before the Worker with a WAF rule

On a custom domain or route, a [WAF rate-limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) runs in the zone's request phases ([phase list](https://developers.cloudflare.com/ruleset-engine/reference/phases-list/)), so a blocked request never starts the gateway. `workers.dev` hostnames have no zone of yours, so they cannot take one.

1. In the dashboard, open your zone, then **Security → WAF → Rate limiting rules**.
2. Match `URI Path equals /graphql`.
3. Count by IP and choose **Block**.

The Free plan allows one rule with a 10-second counting period and a 10-second mitigation timeout; paid zone plans allow more rules and longer periods. Keep the Worker's own limit as a second line.

## Configuration

`gateway` is `workers/gateway/cloudflare.config.ts`, `market` is `workers/market/cloudflare.config.ts`, `catalog` is `workers/catalog/cloudflare.config.ts`. Edit the `production` mode (the `productionWorker` export, or `STANDARD_LIMITS` in the market file), then deploy again. The demo column shows the maintainer's hosted demo for comparison.

| Setting                        | File                     | Default (`production`)                                               | Demo                         | What it does                                                                                                                                            |
| ------------------------------ | ------------------------ | -------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker `name`                  | gateway, market, catalog | `agris`, `agris-market`, `agris-catalog`                             | `agris-demo`, `agris-demo-*` | Worker names in your account. The gateway's `subgraphs("agris")` binds `<prefix>-market` and `<prefix>-catalog` by name, so rename the three together.  |
| `workersDev`                   | gateway                  | `true` (subgraphs: `false`)                                          | `true`                       | Serves the gateway on `<name>.<subdomain>.workers.dev`.                                                                                                 |
| `domains`                      | gateway                  | none                                                                 | none                         | Custom domains on any zone in your account. See [Hostnames](#hostnames).                                                                                |
| `triggers`                     | gateway                  | none                                                                 | none                         | Routes, as `triggers.fetch({ pattern, zone })`.                                                                                                         |
| Account                        | your credentials         | none                                                                 |                              | `cf auth login`, or `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID`. Never in the repository.                                                       |
| `CLIENT_RATE_LIMITER`          | gateway                  | `limit: 60`, `period: 60`, `namespace: "42010"`                      | 10 per 60 s, `"42021"`       | Per-client limit keyed by `CF-Connecting-IP`. Remove it to disable.                                                                                     |
| `GLOBAL_RATE_LIMITER`          | gateway                  | not set                                                              | 120 per 60 s, `"42022"`      | One limit under a constant key for the whole deployment, per Cloudflare location. Checked after the client limit.                                       |
| `GRAPHIQL`                     | gateway                  | not set: on                                                          | `"enabled"`                  | A browser opening `GET /graphql` with no query string gets GraphiQL. `"disabled"` turns it off.                                                         |
| `MARKET_CACHE_MIN_TTL_SECONDS` | gateway                  | not set                                                              | `600`                        | Raises every cacheable answer's freshness to at least this many seconds. Never makes an uncacheable query cacheable.                                    |
| `DEMO_NOTICE`                  | gateway                  | not set                                                              | a notice text                | Sent as an `X-Agris-Demo` header on every response. Printable ASCII only.                                                                               |
| `DEPLOY_GUIDE_URL`             | gateway                  | not set                                                              | the site's deploy section    | Appended to `429` messages so a rate-limited caller learns where to deploy their own.                                                                   |
| `PA_MAX_CONCURRENT_REQUESTS`   | market                   | `6` (`maxConcurrentRequests`)                                        | `2`                          | Concurrent Pearl Abyss calls per upstream host; extra distinct work waits in order. Lower it if you see upstream timeouts.                              |
| `PA_RATE_LIMITER`              | market                   | `limit: 100`, `period: 10`, `namespace: "42003"` (staging `"42002"`) | 20 per 60 s, `"42020"`       | Burst backstop on Pearl Abyss calls. A denied call is not sent.                                                                                         |
| `limits.subrequests`           | gateway, market          | `1000`                                                               | `1000`                       | Subrequests per invocation. The gateway's invocation budget admits Service Binding calls against it; the market coordinator admits Pearl Abyss fetches. |
| `observability`                | gateway, market, catalog | logs `headSamplingRate: 1`, traces `0.05`                            | logs `0.05`, traces `0.01`   | Share of invocations whose Workers Logs and traces are kept.                                                                                            |

Rate-limit namespaces used by this repository: `42001` (local), `42002` (staging market), `42003` (production market), `42010` (production gateway), `42020` to `42022` (demo). Change any that collide with a limiter already in your account.

### Modes

`cf deploy --mode <mode>` picks one entry from the `WORKER_MODES` map in each `cloudflare.config.ts`. The moon tasks wrap them:

- `production`: `moon run gateway:deploy`. The one to self-host.
- `staging`: `moon run gateway:staging-deploy` deploys `agris-staging`, `agris-market-staging` and `agris-catalog-staging`.
- `local`: `moon run agris:dev` runs the gateway on port 8790 and the market Worker on 8791 on your machine.
- `smoke`: the deployed cache smoke test.
- `demo`: the maintainer's hosted demo with the website. Not for forks; for a public instance of your own, deploy `production` and set your own limits.

## Cost

Check [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) for current numbers.

- **Requests and CPU.** Every request to the gateway is a billed request, including ones it rejects with `429`. Calls over Service Bindings to the subgraphs add no request charge, but their CPU time counts ([Service bindings pricing](https://developers.cloudflare.com/workers/platform/pricing/#service-bindings)).
- **Durable Objects.** Each Pearl Abyss call passes through the coordinator. Cached answers never reach it.
- **Static assets** are free; only the demo serves any.

To keep costs predictable:

- leave caching on and select only the fields you need; a query with `orderBook` is cached for 5 seconds;
- batch item IDs into one `Market.items(ids:)` call;
- put a WAF rule in front of a custom domain;
- watch **Workers & Pages → agris → Metrics** after you share the URL.
