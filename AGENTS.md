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
- Vulnerabilities are reported privately as `SECURITY.md` says.
- `agris:format` to fix formatting; `agris:format-check` to verify it.
- `agris:generate` after changing a subgraph schema, a persisted operation, or catalog data.
- `tests:test-headless`, `tests:test-integration`, `tests:test-workers` for one test layer.
- `agris:dev` runs the stack's `local` stage with `alchemy dev`: all four Workers on this machine, the gateway on port 8790. It needs no Cloudflare account and keeps its state in `infra/.alchemy/`.
- `website:build` builds the website into `website/dist`; `website:dev` serves it on port 4321. `agris:docs-deploy` builds it first. `website:links-check`, `website:headers-check` and `website:figure-audit` check the built page's links, its `_headers` (security headers and the Content Security Policy's hashes) and Fig 1's line; `website:live-check` checks how the examples' Run panels sort the demo's answers. `website:record-figure` re-records the README's Fig 1 GIF (`docs/assets/fig1.gif`) from the built site; run it when the figure or the site's look changes.
- `infra:plan` shows what deploying the self-hosted `production` stage would change; it reads the account but changes nothing.

Deploy tasks (`agris:deploy`, `agris:demo-deploy`, `agris:docs-deploy`, `infra:*-deploy`, `infra:destroy`, `infra:smoke-destroy`, `smoke:smoke`) change a live Cloudflare account: run them only when the user asks. The exception is the maintainer's own `demo` and `docs` stages (`agris:demo-deploy`, `agris:docs-deploy`): they are disposable shared instances, so deploying or redeploying them and sending them bounded test traffic are always fine and need no separate ask — see [Stages and the demo](#stages-and-the-demo).

## Workflow

- Every issue or task gets its own branch from `main`, checked out in a new worktree under `.worktrees/` (`git worktree add .worktrees/<name> -b <branch> main`), and all its work happens with that worktree as the working directory. Do not work directly on `main` unless the user explicitly directs the current session to. When spawning a subagent, state whether it shares the parent's branch and worktree or give it its own, and start it there; a subagent never infers this.
- A session's files belong to its worktree, and the main checkout keeps the contents it had: scratch scripts, logs and screenshots go under `.artifacts/` in the task worktree, or into the commit when they are review evidence.
- Every change reaches `main` through a GitHub pull request, opened before the first handoff with `gh pr create --base main --head <branch>`. A task has exactly one pull request, or one stack of them.
- Every handoff message includes the clickable URL of the task's pull request, or of every pull request in its stack, each time, including handoffs after a review correction, without being asked. Copy the URL from `gh pr view --json url` or `gh stack view` rather than retyping it. A handoff without it is incomplete: open the pull request rather than describing where it will be.
- Use `gh stack` whenever the work splits into layers a reviewer can read one at a time, and always for a change too large for one pull request: one branch and pull request per layer, all in the task's worktree, submitted with `gh stack submit`. [.agents/skills/gh-stack/SKILL.md](.agents/skills/gh-stack/SKILL.md) covers the commands; it is upstream's skill from `github/gh-stack` v0.2.1, kept byte-identical and excluded from oxfmt.
- Every pull request names its issue: `Closes #N` for each issue it fixes, `Refs #N` for one it only advances; open the issue first if there is none. The `issue-link` check (`.github/workflows/pr-issue-link.yml`) refuses a body that names none. One pull request per issue; group issues in one pull request or layer only when their code cannot be separated, and name every one.
- A bug or a security finding is reproduced before it is fixed, as a scenario that fails on the current code. If it cannot be reproduced locally, reproduce it where it can be (the `demo` stage is fair game, see [Stages and the demo](#stages-and-the-demo)), and the pull request says how, or why it could not be.
- A change under `packages/catalog-subgraph/src/` or `packages/pearl-abyss/src/`, or to catalog data, changes the catalog identity: run `agris:generate` in that branch, and regenerate rather than hand-resolve a conflict in `generated-catalog-identity.ts`. Fig 1 prints cache keys, so re-record it (`website:record-figure`) in the top pull request of a stack that changes the identity.
- A human reviews every pull request before it merges. Merge only after the human accepts the handed-off work, or when their current message explicitly says to merge without review; a request for changes, approval of a plan, or an instruction given before the work exists is not acceptance.
- `main` refuses direct and force pushes and takes squash merges only: `gh pr merge <number> --squash`, or `gh stack merge --squash` for a stack. The squashed commit's subject is the pull request title, so the title follows the commit format under Conventions.
- Once a pull request or stack merges, bring the main checkout's `main` up to `origin/main` before handing off: `git -C <repository root> pull --ff-only origin main`, then confirm `git rev-parse main origin/main` prints one commit twice. Pull only with `--ff-only`; when it refuses, because local `main` has commits of its own or a tracked file is modified, stop and tell the user rather than resetting, stashing or merging.
- The author of a branch owns it until it merges: keep it rebased on `main`, resolve its conflicts and make its CI pass, including the semantic-commit checks. Never fix another session's branch to get yours in, and never advance `main` by hand.

## Conventions

- TypeScript only, strict, with no `any` or `@ts-ignore`. The site is `.astro` components with TypeScript frontmatter and scripts, and no UI framework.
- Commit subjects and pull request titles are Conventional Commits, `type(scope): summary` (for example `fix(pearl-abyss): reject rows with a missing price`): the type is one of `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`, the scope is optional and lowercase (a moon project ID fits), and `!` before the colon marks a breaking change. `.github/workflows/semantic-commits.yml` enforces it.
- Lint with oxlint, format with oxfmt (120 columns). `website/vendor/` holds the anatomy figure kit kept byte-identical to upstream, including its `.mjs` modules (the one exception to TypeScript only, with `.d.mts` declarations beside them), and is excluded from both.
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

Deployments are stages of the Alchemy stack in `infra/`. `production` is the self-hosting stage (`agris`, `agris-cache`, `agris-market`, `agris-catalog`); any other name is another self-hosted copy. `demo` (the shared API, `agris-demo`) and `docs` (the website, the assets-only `agris-docs` Worker) belong to the maintainer. They are disposable: deploying or redeploying them and sending them bounded test traffic are always fine, without asking first, for example to reproduce or verify a finding. Never deploy them from a fork (a fork has no credentials for the account anyway), and never point real application load at the demo: bounded test traffic is fine, a production workload is not. `smoke` deploys the Workers' own entrypoints the way a host does, plus a public caller, for the cache smoke; destroy it after the run. `local` is what `agris:dev` runs on this machine. Nothing in this repository uses `cf` or a Wrangler configuration; the Workers runtime tests pass their configuration to `@cloudflare/vitest-pool-workers` inline.

## Disclaimer

Agris is unofficial and not affiliated with, endorsed by, or sponsored by Pearl Abyss or Arsha. Black Desert is a trademark of Pearl Abyss. Credit [Arsha](https://github.com/guy0090/api.arsha.io) wherever the README's credits are reproduced. Describe the catalog as the item catalog shipped in the repository; do not name where its names came from.
