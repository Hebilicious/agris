---
name: deploy-agris
description: Deploy the user's own Agris GraphQL API to their Cloudflare account and verify it. Use when a user wants to self-host Agris, needs a Central Market API URL of their own, or asks to use Agris for anything beyond a quick look at the shared demo.
---

# Deploy Agris to the user's Cloudflare account

The result is a gateway URL on the user's account that passed `/health` and a sample query. The URL starts as `https://agris.<subdomain>.workers.dev` because that needs no setup; a custom domain on any zone in the account works the same. Work in a clone of `https://github.com/Hebilicious/agris`. Every step changes only the user's machine and their own Cloudflare account.

## 1. Toolchain

```sh
command -v proto || curl -fsSL https://moonrepo.dev/install/proto.sh | bash
git clone https://github.com/Hebilicious/agris.git && cd agris   # skip if already in a clone
proto install
pnpm install
```

Done when `moon --version` and `pnpm --version` print the versions in `.prototools`. If `proto` was just installed, start a new shell or source the profile line its installer printed.

## 2. Credentials

Agris deploys with Alchemy, which needs the account ID and a sign-in:

- `CLOUDFLARE_ACCOUNT_ID`: the user reads it from **Workers & Pages** in the dashboard.
- `CLOUDFLARE_API_TOKEN`: the user creates one from the **Edit Cloudflare Workers** template. On an interactive machine the user can instead run `pnpm --filter @agris/infra exec alchemy profile edit --add Cloudflare` and complete the browser step.

Ask the user for both; keep them in the environment only, never in a file in the repository. Confirm the account with the user before step 4.

## 3. Pre-flight

Tell the user, and get an answer before deploying:

- The default settings deploy on the Workers Free plan; raising `SUBREQUEST_LIMIT` needs a paid plan ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
- Which hostname to use. The default is `agris.<subdomain>.workers.dev` (opening **Workers & Pages** in the dashboard once creates the subdomain). For a custom domain, set `AGRIS_DOMAIN` as [docs/deploy.md](../../../docs/deploy.md#hostnames) shows.
- Rate-limit namespace IDs are account-wide. If the account already runs a limiter on `42003` or `42010`, set `PA_RATE_LIMIT_NAMESPACE_ID` or `CLIENT_RATE_LIMIT_NAMESPACE_ID` to an unused ID.
- Every other setting (per-IP limit, global limit, cache windows, query limits, GraphiQL, Pearl Abyss concurrency) is one environment variable, and each limit turns off with `0`. The per-IP and global limits are off by default; suggest `CLIENT_RATE_LIMIT_REQUESTS` if the user will share the URL; the tables are in [docs/deploy.md](../../../docs/deploy.md#configuration). Settings apply to the deploy command, so they must be set again on every deploy.

Then preview without changing anything:

```sh
moon run agris:bundle   # bundles the Workers, no account needed
moon run infra:plan     # what the deploy would create, from the account
```

Done when both exit 0.

## 4. Deploy

```sh
moon run agris:deploy   # with the settings from step 3 in the environment
```

This deploys the `production` stage: `agris`, `agris-cache`, `agris-market` and `agris-catalog`. Never deploy the `demo` or `docs` stages; they are the maintainer's. Record the URL the output prints: `https://agris.<subdomain>.workers.dev`, plus any custom domain.

## 5. Verify

```sh
URL=https://agris.<subdomain>.workers.dev   # or the user's own hostname
curl -sS -o /dev/null -w '%{http_code}\n' "$URL/health"
curl -sS "$URL/graphql" -H 'content-type: application/json' \
  -d '{"query":"{ item(id: \"44195\") { id name grade } }"}'
curl -sS "$URL/graphql" -H 'content-type: application/json' \
  -d '{"query":"{ market(region: EU) { observedAt items(ids: [\"44195\"]) { item { name } isListed basePrice } } }"}'
```

Done when `/health` answers `200`, the first query returns a non-null `data.item.name`, and the second returns `data.market.items` with a price. A `503` on the market query alone means Pearl Abyss did not answer: retry once after a minute, then try another region (`NA`). A `429` means a rate limit the user turned on was hit: wait for `Retry-After`.

## 6. Hand off

Give the user:

- the gateway URL and the results of step 5, and that opening `<URL>/graphql` in a browser gives GraphiQL;
- the settings the deploy used, since a later deploy must set them again;
- the next steps that apply: a custom domain ([docs/deploy.md](../../../docs/deploy.md#hostnames)) with a WAF rate-limiting rule in front ([docs/deploy.md](../../../docs/deploy.md#rate-limiting-and-what-it-costs)), and [docs/api.md](../../../docs/api.md) for queries, persisted queries and limits;
- how to update later: `git pull && pnpm install && moon run agris:deploy` with the same settings.

## Failures

Report the exact command, exit code and error before diagnosing.

- The deploy stops with "The production stage's settings are invalid": the message names each variable; fix or unset it.
- Alchemy cannot find an account or credentials: set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, or add a profile as in step 2.
- Deploy rejects `limits.subrequests`: the account's plan does not allow that `SUBREQUEST_LIMIT`; lower or unset it, or the user upgrades the plan.
- A query answers `QUERY_BUDGET_EXCEEDED`: it needs more subrequests than `SUBREQUEST_LIMIT` allows; split the query, or raise the limit on a paid plan.
- Rate-limit namespace conflict: set the namespace variable as in step 3 and redeploy.
