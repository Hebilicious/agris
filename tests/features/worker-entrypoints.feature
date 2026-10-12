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
