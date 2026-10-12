# Smoke

A disposable local Worker bound remotely to a deployed gateway, so the cache-smoke evidence in `tests/features/staging-cache-smoke.feature` can call the private gateway through a real Service Binding. `moon run smoke:smoke` deploys the smoke gateway and runs it.
