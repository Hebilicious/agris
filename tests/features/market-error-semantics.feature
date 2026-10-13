@vitest
Feature: Market error semantics
  A market query that cannot be answered says why in a way the caller can act on. Pearl Abyss throttling is a 429 with
  Retry-After, a query that asks for more than the deployment's budget allows is a QUERY_BUDGET_EXCEEDED field error,
  a 503 means Pearl Abyss could not be reached, and a mistake in the query is a BAD_USER_INPUT field error. No error
  carries the market subgraph's internal text, and none of these answers is stored. A throttled refresh of an answer
  the edge cache still keeps serves that answer stale, as an outage does.

  @scenario:pearl-abyss-throttle-is-429 @provenance:spec @i0
  Scenario: A query whose every Pearl Abyss read is throttled answers 429 with Retry-After
    Given the Pearl Abyss rate limiter refuses every request
    When a caller asks the gateway for the EU summary of item 10006
    Then the gateway answers 429 with Retry-After 60
    And the answer's only error is RATE_LIMITED at the market items
    And the answer is not stored
    And the answer carries none of the gateway's internal headers

  @scenario:pearl-abyss-throttle-serves-stale @provenance:spec @i0
  Scenario: A throttled query with a stale cached answer serves the stale answer
    Given Pearl Abyss answers every request
    And the edge cache keeps the gateway's answer for the EU summary of item 10006
    When that answer expires and the Pearl Abyss rate limiter then refuses every request
    And a caller asks the gateway for the EU summary of item 10006
    Then the gateway answers 200 with the cached EU summary, served stale because its refresh failed
    And the answer carries none of the gateway's internal headers

  @scenario:subgraph-retry-after-zero @provenance:spec @i2
  Scenario: A refused read that names no wait still tells the caller to wait a second
    Given the market subgraph refuses every read with Retry-After 0
    When a caller asks the gateway for the EU summary of item 10006
    Then the gateway answers 429 with Retry-After 1

  @scenario:pearl-abyss-throttle-beside-catalog-data @provenance:spec @i0
  Scenario: A throttled market read next to catalog data keeps the catalog data
    Given the Pearl Abyss rate limiter refuses every request
    When a caller asks the gateway for the name and EU market summary of item 44195
    Then the gateway answers 200 with the name Memory Fragment and a RATE_LIMITED market summary
    And the answer is not stored

  @scenario:pearl-abyss-transport-failure-is-503 @provenance:spec @i0
  Scenario: A query whose every Pearl Abyss read fails to arrive answers 503
    Given Pearl Abyss answers every request with HTTP 500
    When a caller asks the gateway for the EU summary of item 10006
    Then the gateway answers 503 that the Central Market subgraph is unavailable
    And the answer is not stored

  @scenario:budget-refusal-is-query-error @provenance:spec @i0
  Scenario: A budget refusal is a QUERY_BUDGET_EXCEEDED field error, not an outage
    Given Pearl Abyss answers every request
    When a caller asks the gateway for each of these with a subrequest limit of 1
      | query                                                        | path            |
      | { market(region: EU) { hotItems { amount } } }               | market.hotItems |
      | { market(region: EU) { items(ids: ["10006"]) { basePrice } } } | market.items    |
    Then each answer is 200 with a QUERY_BUDGET_EXCEEDED error at its path, and no Pearl Abyss request
    And no answer is stored

  @scenario:market-items-summary-batch-limit @provenance:spec @i0
  Scenario: Market.items obeys the 100-item summary batch limit
    Given Pearl Abyss answers every request
    When a caller asks the gateway for the EU summaries of 101 distinct items
    Then the gateway answers 200 with a QUERY_BUDGET_EXCEEDED error at market.items and no Pearl Abyss request

  @scenario:market-items-summary-batch-at-limit @provenance:spec @i1
  Scenario: Market.items reads 100 distinct items in one summary batch
    Given Pearl Abyss answers every request
    When a caller asks the gateway for the EU summaries of 100 distinct items
    Then the gateway answers 200 with 100 listed items from one Pearl Abyss request

  @scenario:market-catalog-needs-category @provenance:spec @i0
  Scenario: Market.catalog without a category is refused before any work
    Given Pearl Abyss answers every request
    When a caller asks the gateway for the EU catalog without a category
    Then the gateway answers 400 that the query is invalid for the schema, with no Pearl Abyss request
    And the client schema requires Market.catalog's category

  @scenario:market-client-input-errors @provenance:spec @i0
  Scenario: A mistake in a market argument is a BAD_USER_INPUT field error that says what is wrong
    Given Pearl Abyss answers every request
    When a caller asks the gateway for each of these
      | query                                                                        | message                                              |
      | { market(region: EU) { items(ids: ["abc"]) { basePrice } } }                 | Item ID must be a positive safe integer              |
      | { market(region: EU) { catalog(category: { main: 0 }) { basePrice } } }      | Unknown Central Market category: main 0              |
      | { market(region: EU) { catalog(category: { main: 1, sub: 99 }) { basePrice } } } | Unknown Central Market category: main 1, sub 99  |
      | { market(region: EU) { items(ids: ["1"]) { orderBook(enhancementLevel: 21) { price } } } } | Enhancement level must be an integer from 0 through 20 |
    Then each answer is 200 with BAD_USER_INPUT errors carrying its message, and no Pearl Abyss request

  @scenario:market-internal-errors-masked @provenance:spec @i0
  Scenario: An unreadable Pearl Abyss answer reaches the caller as a closed error, not its internal text
    Given Pearl Abyss answers EU summaries and sends NA an answer that is not a Central Market response
    When a caller asks the gateway for the EU and NA summaries of item 10006
    Then the gateway answers 200 with the EU summary and one UPSTREAM_UNAVAILABLE error at the NA items
    And no error mentions Pearl Abyss, Huffman or the response's shape

  @scenario:gateway-errors-masked-in-development @provenance:spec @i1
  Scenario: The gateway's own unexpected error is masked even where NODE_ENV says development
    Given Pearl Abyss answers every request
    And a gateway plugin that fails with an internal error, in a runtime whose NODE_ENV is development
    When a caller asks the gateway for the EU summary of item 10006
    Then no error carries the internal error's message, its stack or the original error
