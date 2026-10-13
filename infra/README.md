# @agris/infra

Agris's deploy definition: one [Alchemy](https://alchemy.run) stack, `alchemy.run.ts`, whose stage names what it deploys. `docs` is the website as the assets-only `agris-docs` Worker, `demo` the shared API, `smoke` the cache smoke's Workers (`src/smoke/`: the Workers' own entrypoints deployed as a host deploys them, and a public caller), and any other stage a self-hosted API. `alchemy dev` (`moon run agris:dev`) runs the `local` stage on this machine with its state kept in `.alchemy/`. [docs/deploy.md](../docs/deploy.md) is the guide.

Each Worker declares itself in `src/<name>/`: `contract.ts` (its `Cloudflare.Worker` tag and RPC shape), `props.ts` (its name, bindings and variables for one stage's settings) and `worker.ts` (`Contract.make(Stack.useSync(...), Effect.gen(...))`, which serves through the Worker package's runtime-independent module). `src/settings.ts` states every stage's settings and reads a self-hosted stage's from the deploy command's environment; the website reads it too.

The Worker packages in `apps/*` never import this directory, so a host that mounts Agris and installs `packages/*` and `apps/*` needs no Alchemy.

| Command                        | What it does                                             |
| ------------------------------ | -------------------------------------------------------- |
| `moon run infra:bundle`        | Bundle every Worker as a deploy does, without an account |
| `moon run agris:dev`           | Run the `local` stage on this machine                    |
| `moon run infra:plan`          | Show what deploying `production` would change            |
| `moon run agris:deploy`        | Deploy the self-hosted `production` stage                |
| `moon run infra:destroy`       | Delete the `production` stage                            |
| `moon run smoke:smoke`         | Deploy the `smoke` stage and run the cache smoke on it   |
| `moon run infra:smoke-destroy` | Delete the `smoke` stage                                 |
| `moon run agris:demo-deploy`   | Deploy the shared demo (maintainer only)                 |
| `moon run agris:docs-deploy`   | Build and deploy the website (maintainer only)           |
