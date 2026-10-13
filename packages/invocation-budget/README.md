# @agris/invocation-budget

Fail-closed admission against a Worker invocation's subrequest budget, and bounded connection acquisition for one invocation. Gateway, subgraph and Pearl Abyss client code use it; it depends on nothing in this repository.

The budget is the deployment's `SUBREQUEST_LIMIT` (`subrequestLimitFromBinding`), 50 when unset, which is also each Worker's `limits.subrequests`. `marketSummaryRequestLimitFor` derives the market-summary batch limit from it. `@agris/invocation-budget/subrequest-limit` exports those, and nothing else, for code that loads modules without a TypeScript loader.
