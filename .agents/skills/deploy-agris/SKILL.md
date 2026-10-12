---
name: deploy-agris
description: Deploy the user's own Agris GraphQL API to their Cloudflare account and verify it. Use when a user wants to self-host Agris, needs a Central Market API URL of their own, or asks to use Agris for anything beyond a quick look at the shared demo.
---

# Deploy Agris to the user's Cloudflare account

The result is a gateway URL on the user's account that passed `/health` and a sample query. The URL starts as `https://agris.<subdomain>.workers.dev` because that needs no setup; a custom domain or route on any zone in the account works the same. Work in a clone of `https://github.com/Hebilicious/agris`. Every step changes only the user's machine and their own Cloudflare account.

## 1. Toolchain

```sh
command -v proto || curl -fsSL https://moonrepo.dev/install/proto.sh | bash
git clone https://github.com/Hebilicious/agris.git && cd agris   # skip if already in a clone
proto install
pnpm install
```

Done when `moon --version` and `pnpm --version` print the versions in `.prototools`. If `proto` was just installed, start a new shell or source the profile line its installer printed.

## 2. Credentials

Check first:

```sh
pnpm --filter @agris/gateway-worker exec cf auth whoami
```

If it reports no login, either:

- interactive machine: `pnpm --filter @agris/gateway-worker exec cf auth login` (the user completes the browser step);
- headless or CI: the user creates an API token from the **Edit Cloudflare Workers** template and you export `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID` when the token reaches several accounts.

Ask the user for the token; keep it in the environment only, never in a file in the repository. Done when `whoami` names the account the user intends to deploy to; confirm the account name with the user before step 4.

## 3. Pre-flight

Tell the user, and get an answer before deploying:

- The Workers Paid plan is required: the gateway and market Worker set `limits.subrequests` to 1,000, and the free plan allows at most 50 ([docs/free-plan.md](../../../docs/free-plan.md)).
- Which hostname to use. The default is `agris.<subdomain>.workers.dev` (opening **Workers & Pages** in the dashboard once creates the subdomain). For a custom domain or route, add `domains` or `triggers` to `productionWorker` in `workers/gateway/cloudflare.config.ts` as [docs/deploy.md](../../../docs/deploy.md#hostnames) shows.
- Rate-limit namespace IDs are account-wide. If the account already runs a limiter on `42003` or `42010`, change `PA_RATE_LIMITER`'s `namespace` in `workers/market/cloudflare.config.ts` or `CLIENT_RATE_LIMITER`'s in `workers/gateway/cloudflare.config.ts` to an unused ID.
- Other settings worth asking about (per-IP limit, GraphiQL, concurrency) are in the table in [docs/deploy.md](../../../docs/deploy.md#configuration).

Then bundle without uploading:

```sh
moon run agris:dry-run
```

Done when the task exits 0.

## 4. Deploy

```sh
moon run gateway:deploy
```

This deploys `agris-market`, `agris-catalog`, then `agris`, in `production` mode. Use only this mode; `demo` is reserved for the maintainer's hosted instance. Record the URL the output prints: `https://agris.<subdomain>.workers.dev`, plus any custom domain or route you added.

## 5. Verify

```sh
URL=https://agris.<subdomain>.workers.dev   # or the user's own hostname
curl -sS -o /dev/null -w '%{http_code}\n' "$URL/health"
curl -sS "$URL/graphql" -H 'content-type: application/json' \
  -d '{"query":"{ item(id: \"44195\") { id name grade } }"}'
curl -sS "$URL/graphql" -H 'content-type: application/json' \
  -d '{"query":"{ market(region: EU) { observedAt items(ids: [\"44195\"]) { item { name } isListed basePrice } } }"}'
```

Done when `/health` answers `200`, the first query returns a non-null `data.item.name`, and the second returns `data.market.items` with a price. A `503` on the market query alone means Pearl Abyss did not answer: retry once after a minute, then try another region (`NA`). A `429` means the per-IP limit (60 per minute) was hit: wait for `Retry-After`.

## 6. Hand off

Give the user:

- the gateway URL and the results of step 5, and that opening `<URL>/graphql` in a browser gives GraphiQL;
- the next steps that apply: a custom domain or route ([docs/deploy.md](../../../docs/deploy.md#hostnames)) with a WAF rate-limiting rule in front ([docs/deploy.md](../../../docs/deploy.md#rate-limiting)), and [docs/api.md](../../../docs/api.md) for queries, persisted queries and limits;
- how to update later: `git pull && pnpm install && moon run gateway:deploy`.

## Failures

Report the exact command, exit code and error before diagnosing.

- `cf` cannot find an account or asks for one: set `CLOUDFLARE_ACCOUNT_ID`.
- Deploy rejects `limits.subrequests`: the account is on the free plan; the user upgrades to Workers Paid.
- Gateway deploy fails on a missing service: the market or catalog deploy failed first; fix that error and rerun `moon run gateway:deploy`.
- Rate-limit namespace conflict: change the namespace as in step 3 and redeploy.
