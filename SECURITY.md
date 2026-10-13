# Security policy

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (<https://github.com/Hebilicious/agris/security/advisories/new>). Do not open a public issue or pull request for it. If the button is missing, open an issue that asks for a private contact and leaves out every detail of the finding.

Say what you found, how to reproduce it, and what it lets someone do. You will get an answer as soon as the maintainer can look at it; Agris is maintained by one person in their spare time, so there is no fixed response time. When a fix is ready, it is released with an advisory that credits you, unless you ask not to be named.

## Scope

In scope:

- the code in this repository: the gateway, cache, market and catalog Workers, the packages they use, the Alchemy stack in `infra/` and the deploy skill;
- the website's own code;
- a self-hosted deployment that runs this code with its documented settings.

Out of scope:

- Pearl Abyss's servers and the data they return; Agris only relays it;
- Cloudflare's platform, and settings a deployer chose that the documentation warns against;
- denial of service by sheer volume against the shared demo, which is rate limited on purpose;
- findings in dependencies that Agris does not reach; report those upstream.

## The shared demo

The demo API (`agris-demo.hebilicious.workers.dev`) and the website are deployments of `main` that the maintainer runs as a courtesy. The demo is limited, may be switched off at any time, and holds no user data: there are no accounts, keys or cookies. Do not load-test it or probe it beyond what you need to show a finding; a self-hosted copy (see [docs/deploy.md](docs/deploy.md)) is the place to test.

## Supported versions

Agris has no releases yet. Fixes land on `main`; update a deployment with `git pull`, `pnpm install` and `moon run agris:deploy`.
