@vitest-workers
Feature: Central Market Worker entrypoints
  The deployed Agris Proxy and subgraph Worker entrypoints cooperate through Cloudflare runtime bindings.

  @scenario:worker-entrypoints-cached-market-item @provenance:spec @i1
  Scenario: The real Agris Proxy and market Workers serve and cache one market item
    Given a cold operation-result cache around the Agris Proxy Worker entrypoint
    When the same cacheable market summary query is sent through the Agris Proxy Worker twice
    Then both Agris Proxy responses contain the Pearl Abyss summary
    And the first Agris Proxy response is a live cache miss
    And the second Agris Proxy response is a fresh cache hit

  @scenario:worker-entrypoints-market-outage @provenance:spec @i1
  Scenario: A total Pearl Abyss outage reaches the gateway as unavailable
    Given a cold operation-result cache around the Agris Proxy Worker entrypoint
    When the real Agris Proxy queries a market item while Pearl Abyss is unavailable
    Then the gateway returns an uncached HTTP 503 refresh failure

  @scenario:worker-entrypoints-summary-operation-budget-rejection @provenance:spec @i0
  Scenario: A seventh distinct summary batch is rejected before Pearl Abyss
    When one Agris operation concurrently requests seven regional market-summary keys
    Then six market-summary paths return data and the seventh is nullable
    And the rejected path reports QUERY_BUDGET_EXCEEDED without reaching Pearl Abyss

  @scenario:worker-entrypoints-unlimited-market @provenance:spec @i1
  Scenario: A market Worker without a Pearl Abyss rate limit or concurrency setting serves without either
    When the real Agris Proxy queries two market items through a market Worker that binds neither PA_RATE_LIMITER nor PA_MAX_CONCURRENT_REQUESTS
    Then both market items come back with their Pearl Abyss summary

  @scenario:worker-entrypoints-gateway-plugins @provenance:spec @i1
  Scenario: An Envelop plugin on the gateway's extension point sees each executed operation
    When the real Agris Proxy executes a market item query with a plugin that records each operation
    Then the plugin recorded the operation WorkerEntrypoints once
    And the response still carries the Pearl Abyss summary

  @scenario:worker-entrypoints-local-gateway-settings @provenance:spec @i1
  Scenario: The local gateway applies the subrequest budget and cache settings its host binds
    When the local gateway reads an item's NA and EU market summaries with SUBREQUEST_LIMIT 3 and CACHE_NEVER_STORED naming Item.marketSummary
    Then one summary has data and the other reports QUERY_BUDGET_EXCEEDED
    And the answer is never stored

  @scenario:worker-entrypoints-caller-abort-reaches-coordinator @provenance:spec @i0
  Scenario: A market read whose caller gives up leaves the coordinator's queue unsent
    Given a market Worker whose coordinator runs one Pearl Abyss request at once while Pearl Abyss holds the first
    When a second market read waits behind it and its caller gives up
    And the first is released and a third market read follows
    Then only the first and the third market reads reached Pearl Abyss
