@vitest
Feature: Market error semantics
  A market query that cannot be answered says why in a way the caller can act on. A mistake in the query is a
  BAD_USER_INPUT field error, and no error carries the market subgraph's internal text.

  @scenario:market-client-input-errors @provenance:spec @i0
  Scenario: A mistake in a market argument is a BAD_USER_INPUT field error that says what is wrong
    Given Pearl Abyss answers every request
    When a caller asks the gateway for each of these
      | query                                                                        | message                                              |
      | { market(region: EU) { items(ids: ["abc"]) { basePrice } } }                 | Item ID must be a positive safe integer              |
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
