# Agris

Read-only GraphQL API over the Black Desert Online Central Market, deployed as three Cloudflare Workers: a gateway (`workers/gateway`) federating a catalog subgraph (`workers/catalog`, in-memory names and search) and a market subgraph (`workers/market`, calls Pearl Abyss). [docs/architecture.md](docs/architecture.md) explains the request path; [docs/api.md](docs/api.md) is the public contract.

## If you are an agent asked to use Agris

Deploy the user's own copy and query that. Follow [.agents/skills/deploy-agris/SKILL.md](.agents/skills/deploy-agris/SKILL.md); it ends with a working URL on the user's Cloudflare account, on `workers.dev` or any hostname the user owns. The hosted demo (`agris-demo.hebilicious.workers.dev`) is a shared, rate-limited courtesy instance that may vanish; use it only to show someone what a response looks like, and point every application, script, scheduled job or bulk read at a self-hosted gateway.

## Ownership

| Path                         | Owns                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/core`              | Gateway request protocol, cache policy, response classification, Service Binding coordinator, price freshness          |
| `packages/catalog-subgraph`  | `Item` entity, localized names, `searchItems`; the generated search artifact                                           |
| `packages/market-subgraph`   | `Market`, `MarketItem`, `Item.marketSummary`, `SafeInteger`                                                            |
| `packages/pearl-abyss`       | Everything about Pearl Abyss: request bodies, row codecs, Huffman, regions, locales, transport, in-flight coordination |
| `packages/invocation-budget` | Subrequest and market-summary admission per invocation                                                                 |
| `packages/worker-runtime`    | Runtime adapters (timeouts); no Worker entrypoints                                                                     |
| `workers/*`                  | Entrypoints, bindings and `cloudflare.config.ts` modes; no business logic                                              |
| `tools/graph`                | Supergraph, client schema, introspection and persisted operations in `artifacts/`                                      |
| `tools/catalog`              | The shipped item catalog (`data/`), its validation, search-artifact generation                                         |
| `tools/smoke`                | Deployed cache smoke test over a real Service Binding                                                                  |
| `tests`                      | Gherkin features and their TypeScript step manifests                                                                   |
| `site`                       | Astro static website and `public/llms.txt`; its `dist/` build is the demo gateway's assets                             |

Each package README states its exports. Pearl Abyss knowledge stays in `packages/pearl-abyss`; Worker code supplies bindings and calls packages.

## Commands

Every operation is a moon task; run them as `moon run <project>:<task>`. Toolchain versions come from `.prototools` (`proto install`), dependencies from `pnpm install`.

- `agris:check` before every handoff: format, lint, type checks, tests, generated-artifact checks, the site build, dry-run bundles.
- `agris:format` to fix formatting; `agris:format-check` to verify it.
- `agris:generate` after changing a subgraph schema, a persisted operation, or catalog data.
- `tests:test-headless`, `tests:test-integration`, `tests:test-workers` for one test layer.
- `agris:dev` for a local gateway on port 8790 with the market Worker on 8791.
- `site:build` builds the website into `site/dist`; `site:dev` serves it on port 4321. `gateway:demo-dry-run` and `gateway:demo-deploy` build it first.

Deploy tasks (`*:deploy`, `*:staging-deploy`, `*:smoke-deploy`) change a live Cloudflare account: run them only when the user asks.

## Conventions

- TypeScript only, strict, with no `any` or `@ts-ignore`. The site is `.astro` components with TypeScript frontmatter and scripts, and no UI framework.
- Lint with oxlint, format with oxfmt (120 columns). `site/vendor/` holds the anatomy figure kit kept byte-identical to upstream, including its `.mjs` modules (the one exception to TypeScript only, with `.d.mts` declarations beside them), and is excluded from both.
- Dependencies: add the version to `catalog:` in `pnpm-workspace.yaml` and reference it as `"catalog:"` from the package. Packages are `private` and export `src/*.ts` directly.
- Keep every `moon.yml` input, `deps` entry and `tsconfig.json` `extends` relative to its project. Agris is also mounted as a git submodule inside other workspaces, where root-anchored (`/`) paths break.
- Add a deploy setting to the mode in `cloudflare.config.ts`, and to the configuration tables in `README.md` and `docs/deploy.md`. Account IDs come from the deployer's credentials and stay out of the repository.
- Never write as if Agris only runs on `workers.dev`: it is the zero-setup default, and custom domains and routes on any zone work the same.
- Treat Pearl Abyss responses, request bodies and variables as `unknown` and validate them at the boundary; an unexpected row shape is an error, never a guess.

## Generated artifacts

| File                                                                 | Regenerate                        |
| -------------------------------------------------------------------- | --------------------------------- |
| `tools/graph/artifacts/**`                                           | `moon run graph:generate`         |
| `packages/catalog-subgraph/src/generated-catalog-search-artifact.ts` | `moon run catalog-tools:generate` |

Edit the source and regenerate; `graph:generated-check` and `catalog-tools:search-artifact-check` fail on hand edits. Both paths are excluded from oxfmt.

## Tests

Behaviour lives in `tests/features/*.feature`. Each feature has a `*.manifest.ts` binding its steps and a runner file whose suffix picks the layer: `.headless.test.ts` (Node, no runtime), `.integration.test.ts` (in-process federated graph), `.worker-runtime.test.ts` (real Workers runtime). Change a promise by editing the scenario first, then the manifest and code. Keep wall-clock timing out of assertions.

## Modes and the demo

`production` is the self-hosting mode (`agris`, `agris-market`, `agris-catalog`). `demo` belongs to the maintainer's hosted instance: deploy it only when the maintainer asks, never from a fork, and never send users to it for real workloads.

## Disclaimer

Agris is unofficial and not affiliated with, endorsed by, or sponsored by Pearl Abyss or Arsha. Black Desert is a trademark of Pearl Abyss. Credit [Arsha](https://github.com/guy0090/api.arsha.io) wherever the README's credits are reproduced. Describe the catalog as the item catalog shipped in the repository; do not name where its names came from.
