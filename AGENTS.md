# Agris

Read-only GraphQL API over the Black Desert Online Central Market, deployed as four Cloudflare Workers: a gateway (`apps/gateway`, plus the cache Worker `infra/` gives it) federating a catalog subgraph (`apps/catalog`, in-memory names and search) and a market subgraph (`apps/market`, calls Pearl Abyss). [docs/architecture.md](docs/architecture.md) explains the request path; [docs/api.md](docs/api.md) is the public contract.

## If you are an agent asked to use Agris

Deploy the user's own copy and query that. Follow [.agents/skills/deploy-agris/SKILL.md](.agents/skills/deploy-agris/SKILL.md); it ends with a working URL on the user's Cloudflare account, on `workers.dev` or any hostname the user owns. The hosted demo API (`agris-demo.hebilicious.workers.dev/graphql`; the website is `agris-docs.hebilicious.workers.dev`) is a shared, rate-limited courtesy instance that may vanish; use it only to show someone what a response looks like, and point every application, script, scheduled job or bulk read at a self-hosted gateway.

## Ownership

| Path                         | Owns                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/core`              | Gateway request protocol, cache policy, response classification, Service Binding coordinator, price freshness          |
| `packages/catalog-subgraph`  | `Item` entity, localized names, `searchItems`; the generated search artifact                                           |
| `packages/market-subgraph`   | `Market`, `MarketItem`, `Item.marketSummary`, `SafeInteger`                                                            |
| `packages/pearl-abyss`       | Everything about Pearl Abyss: request bodies, row codecs, Huffman, regions, locales, transport, in-flight coordination |
| `packages/invocation-budget` | Subrequest and market-summary admission per invocation                                                                 |
| `packages/worker-runtime`    | Runtime adapters (timeouts); no Worker entrypoints                                                                     |
| `apps/*`                     | The Worker packages: entrypoints and the bindings they read; host-independent `gateway.ts`/`market.ts`/`catalog.ts`    |
| `website`                    | Astro static website, Fig 1 (`src/figure`) and `/llms.txt`; its `dist/` build is the assets-only `agris-docs` Worker   |
| `infra`                      | The Alchemy stack: the `docs`, `demo`, `smoke` and self-hosted stages, each Worker's props, stage settings, bundles    |
| `data/catalog`               | The shipped item catalog: one `items.json` per locale, and `same-as-english.json`                                      |
| `tools/catalog`              | Catalog validation and search-artifact generation                                                                      |
| `tools/schema`               | Supergraph, client schema, introspection and persisted operations in `artifacts/`                                      |
| `tools/smoke`                | The cache smoke's caller Worker, which reaches the `smoke` stage's private gateway over a real Service Binding         |
| `tests`                      | Gherkin features and their TypeScript step manifests                                                                   |

Each package README states its exports. Pearl Abyss knowledge stays in `packages/pearl-abyss`; Worker code supplies bindings and calls packages. Nothing in `packages/*` or `apps/*` imports `infra/` or Alchemy: hosts that mount Agris install those two directories alone, on their own `effect` version (a host may pin an older `effect`, such as 4.0.0-rc.118), so code there must type-check and run without Alchemy. `apps/` holds only the three Worker packages, so the website, the Alchemy stack and the tools stay out of a host's install.

A moon project's ID is its package name without `@agris/`. `packages/catalog-subgraph` cites `schema:check` and its generated search artifact cites `catalog-tools:generate`, and that code's text is part of the catalog identity in every gateway cache key: renaming either project changes the identity, so run `agris:generate` after it.

## Commands

Every operation is a moon task; run them as `moon run <project>:<task>`. Toolchain versions come from `.prototools` (`proto install`), dependencies from `pnpm install`.

- `agris:check` before every handoff: format, lint, type checks, tests, generated-artifact checks, the website build and the Alchemy bundles (`agris:bundle`, no account needed), which include the Workers' own entrypoints as a host deploys them.
- `agris:format` to fix formatting; `agris:format-check` to verify it.
- `agris:generate` after changing a subgraph schema, a persisted operation, or catalog data.
- `tests:test-headless`, `tests:test-integration`, `tests:test-workers` for one test layer.
- `agris:dev` runs the stack's `local` stage with `alchemy dev`: all four Workers on this machine, the gateway on port 8790. It needs no Cloudflare account and keeps its state in `infra/.alchemy/`.
- `website:build` builds the website into `website/dist`; `website:dev` serves it on port 4321. `agris:docs-deploy` builds it first. `website:links-check` and `website:figure-audit` check the built page's links and Fig 1's line; `website:live-check` checks how the examples' Run panels sort the demo's answers. `website:record-figure` re-records the README's Fig 1 GIF (`docs/assets/fig1.gif`) from the built site; run it when the figure or the site's look changes.
- `infra:plan` shows what deploying the self-hosted `production` stage would change; it reads the account but changes nothing.

Deploy tasks (`agris:deploy`, `agris:demo-deploy`, `agris:docs-deploy`, `infra:*-deploy`, `infra:destroy`, `infra:smoke-destroy`, `smoke:smoke`) change a live Cloudflare account: run them only when the user asks.

## Workflow: issues, branches and pull requests

- Every change starts from a GitHub issue. If none exists, open one that states the problem before writing code. A bug or a security finding is reproduced first, as a scenario that fails on the current code; if it cannot be reproduced locally, the issue and the pull request say so and why.
- One concern per pull request, and one pull request per issue. Group issues in one pull request only when their code cannot be separated, and name every one of them. The body says `Closes #N` for each issue it fixes (CI's `pr-issue-link` check refuses a body without one), what changed, and how it was reproduced.
- Never commit to `main`. Work that has more than one concern, or whose parts depend on each other, is a stack of pull requests made with `gh stack` ([.agents/skills/gh-stack/SKILL.md](.agents/skills/gh-stack/SKILL.md)): plan the layers and run `gh stack init` before writing code, commit each change in the layer that owns it, and keep every layer passing `agris:check` on its own. Independent work goes in its own stack or pull request, never on top of an unrelated one.
- Agents in parallel each work in their own git worktree on their own branch; the agent that splits or merges their work owns the stack. Push, submit and merge only when the user asks.
- A change under `packages/catalog-subgraph/src/` or `packages/pearl-abyss/src/`, or to catalog data, changes the catalog identity: run `agris:generate` in that branch, and regenerate rather than hand-resolve a conflict in `generated-catalog-identity.ts`. Fig 1 prints cache keys, so re-record it (`website:record-figure`) in the top pull request of a stack that changes the identity.

## Conventions

- TypeScript only, strict, with no `any` or `@ts-ignore`. The site is `.astro` components with TypeScript frontmatter and scripts, and no UI framework.
- Lint with oxlint, format with oxfmt (120 columns). `website/vendor/` holds the anatomy figure kit kept byte-identical to upstream, including its `.mjs` modules (the one exception to TypeScript only, with `.d.mts` declarations beside them), and is excluded from both. `.agents/skills/gh-stack/` is the `gh-stack` skill as `gh skill install github/gh-stack skills/gh-stack --dir .agents/skills` writes it; it is excluded from oxfmt, and changes only through `gh skill update`.
- Dependencies: add the version to `catalog:` in `pnpm-workspace.yaml` and reference it as `"catalog:"` from the package. Packages are `private` and export `src/*.ts` directly.
- Keep every `tsconfig.json` `extends` relative to its project: other workspaces mount Agris as a git submodule and install its `packages/*` and `apps/*` through pnpm.
- List everything a cached task reads in its `inputs`. Moon does not fold a dependency task's hash into its dependents, so `deps` only orders tasks; a task that runs, imports or reads another project's code also takes `@group(agris-sources)` (`.moon/tasks/sources.yml`), and a new cross-project read joins that group.
- A deployment setting is one plain environment variable with a default, and every limit turns off with `0`, except `SUBREQUEST_LIMIT`, which every Worker needs. A runtime setting is read by the Worker (`CACHE_*` in `packages/core/src/protocol/cache-freshness.ts`, `QUERY_*` in `document-limits.ts`), which refuses unknown names in its prefix; a deploy-time setting is read in `infra/src/settings.ts`. Add it there, to `tests/features/deploy-settings.feature`, and to the configuration tables in `README.md` and `docs/deploy.md`. Account IDs come from `CLOUDFLARE_ACCOUNT_ID` at deploy time and stay out of the repository; Alchemy keeps state in the account's state-store Worker.
- Never write as if Agris only runs on `workers.dev`: it is the zero-setup default, and custom domains and routes on any zone work the same.
- The website is written for people: plain words, no links to files in the repository, and every outbound link in a new tab with `rel="noopener noreferrer"` (`website:links-check` enforces both). It never types a cache window, rate or limit: pages read them through `website/src/facts.ts`, cache windows from `SELF_HOSTED.cacheFreshness` and `DEMO.cacheFreshness`. Fig 1's browser code imports nothing from the gateway; the build writes what it needs into the figure's data block.
- The site's identity: parchment and violet ink by day, violet night after dark, brass gold for actions, HIT teal, MISS violet, STALE amber and 429 crimson; Cinzel (OFL, `website/public/fonts`) for display type. The hero and README banner use the Agris artwork (`website/public/art/`, `docs/assets/agris-banner.jpg`), original to the project and MIT licensed like the favicon. The project owner decides which artwork the project uses.
- Treat Pearl Abyss responses, request bodies and variables as `unknown` and validate them at the boundary; an unexpected row shape is an error, never a guess.

## Generated artifacts

| File                                                                 | Regenerate                        |
| -------------------------------------------------------------------- | --------------------------------- |
| `tools/schema/artifacts/**`                                          | `moon run schema:generate`        |
| `packages/catalog-subgraph/src/generated-catalog-search-artifact.ts` | `moon run catalog-tools:generate` |
| `packages/core/src/protocol/generated-catalog-identity.ts`           | `moon run catalog-tools:generate` |

Edit the source and regenerate; `schema:generated-check` and `catalog-tools:search-artifact-check` fail on hand edits. The first two paths are excluded from oxfmt. The catalog identity is a checksum of the catalog data that every gateway cache key includes, so a catalog change never serves names cached by an earlier release.

## Tests

Behaviour lives in `tests/features/*.feature`. Each feature has a `*.manifest.ts` binding its steps and a runner file whose suffix picks the layer: `.headless.test.ts` (Node, no runtime), `.integration.test.ts` (in-process federated graph), `.worker-runtime.test.ts` (real Workers runtime). Change a promise by editing the scenario first, then the manifest and code. Keep wall-clock timing out of assertions.

## Stages and the demo

Deployments are stages of the Alchemy stack in `infra/`. `production` is the self-hosting stage (`agris`, `agris-cache`, `agris-market`, `agris-catalog`); any other name is another self-hosted copy. `demo` (the shared API, `agris-demo`) and `docs` (the website, the assets-only `agris-docs` Worker) belong to the maintainer: deploy them only when the maintainer asks, never from a fork, and never send users to the demo for real workloads. `smoke` deploys the Workers' own entrypoints the way a host does, plus a public caller, for the cache smoke; destroy it after the run. `local` is what `agris:dev` runs on this machine. Nothing in this repository uses `cf` or a Wrangler configuration; the Workers runtime tests pass their configuration to `@cloudflare/vitest-pool-workers` inline.

## Disclaimer

Agris is unofficial and not affiliated with, endorsed by, or sponsored by Pearl Abyss or Arsha. Black Desert is a trademark of Pearl Abyss. Credit [Arsha](https://github.com/guy0090/api.arsha.io) wherever the README's credits are reproduced. Describe the catalog as the item catalog shipped in the repository; do not name where its names came from.
