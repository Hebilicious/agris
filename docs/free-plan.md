# Why Agris needs Workers Paid

Agris needs the Workers Paid plan today. This page explains why, and why the item catalog lives in memory.

Cloudflare's numbers below were read from its documentation in October 2026. Check the linked pages before relying on them.

## Why the catalog is in memory

The catalog subgraph answers two things: names and grades for item IDs, and name search. It does both from a module bundled into the catalog Worker: 12,508 items in 12 languages, plus a prebuilt trigram index per language. That choice buys a lot:

- **No subrequest per lookup.** Joining names to a market response, or answering a search, costs no `fetch`, KV read or database query. Nothing counts against the subrequest limit and nothing can time out.
- **No storage to pay for or provision.** There is no database, no read quota and no migration step. A deploy is the whole setup.
- **Fast search.** A query's trigrams select one posting list and every candidate is confirmed in memory, which takes well under a millisecond. See [research/in-memory-name-search.md](research/in-memory-name-search.md).
- **Immutable per release.** The data only changes when the repository changes, so a deploy is an atomic switch and a rollback is a redeploy. The gateway caches catalog-only answers for a year.

The cost is size: the catalog Worker bundles about 28 MiB of JavaScript, 8.1 MiB gzipped (`moon run catalog-worker:dry-run` prints both).

## What blocks the free plan

Bundle size is no longer the blocker. Cloudflare's current limit is 64 MiB uncompressed on both plans, and "There is no compressed size limit" ([Workers limits: Worker size](https://developers.cloudflare.com/workers/platform/limits/#worker-size)). Earlier guidance in this repository cited a 3 MB free-plan script limit; that is out of date.

What does block it:

| Limit                      | Workers Free | Workers Paid        | Agris today                                                 |
| -------------------------- | ------------ | ------------------- | ----------------------------------------------------------- |
| Subrequests per invocation | 50           | 10,000 (up to 10M)  | `limits.subrequests: 1000` on the gateway and market Worker |
| CPU time per HTTP request  | 10 ms        | 30 s default, 5 min | Query validation and federation planning run on every miss  |
| Requests per day           | 100,000      | no limit            | Every gateway request counts, including `429`s              |

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (account plan limits, [subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests), [CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)) and [Wrangler configuration: limits](https://developers.cloudflare.com/workers/wrangler/configuration/#limits), which states "The free account maximum is 50" for `subrequests`. The same limits page lists a separate allowance of 1,000 "subrequests to internal services" on the free plan.

So the configuration as shipped asks for more than a free account can grant, and the per-request CPU budget is tight for a GraphQL gateway. No one has measured Agris's CPU per request against the 10 ms limit yet.
