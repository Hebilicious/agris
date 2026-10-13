# Smoke

The cache smoke: `tests/features/deployed-cache-smoke.feature` run against the Alchemy stack's `smoke` stage, which deploys the gateway, market and catalog Workers' own entrypoints as a host that mounts Agris deploys them, and this caller. The caller (`caller/src/index.ts`) is public on `workers.dev` and reaches the private gateway through a real Service Binding.

- `moon run smoke:smoke` deploys the stage (`infra:smoke-deploy`) and runs the smoke against it.
- `moon run smoke:verify-deployed` runs the smoke against the stage already deployed.
- `moon run infra:smoke-destroy` deletes the stage's Workers.
