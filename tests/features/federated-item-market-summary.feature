@vitest
Feature: Federated Item market summaries
  Item price facts remain naturally nested while Agris coalesces one bounded Market selection path into one Pearl Abyss summary read.

  @scenario:bounded-federated-item-summary-batch @provenance:minimal @i1
  Scenario: One federated Item selection path batches 100 unique summaries
    Given 100 catalog Items include listed market facts except for omitted item 30042
    When an authorized caller requests their EU market summaries with item 30007 duplicated through Agris Proxy
    Then all Item siblings survive in requested order with one timestamped EU summary each
    And both copies of item 30007 share its listed facts while item 30042 is explicitly unlisted
    And Pearl Abyss receives one ordered summary batch containing the 100 unique Item IDs

  @scenario:oversized-federated-item-summary-batch @provenance:minimal @i0
  Scenario: A 101-Item federated summary batch fails before Pearl Abyss work
    Given 101 catalog Items have available market facts
    When an authorized caller requests all of their EU market summaries through Agris Proxy
    Then every Item identity survives with a null market summary and QUERY_BUDGET_EXCEEDED
    And Pearl Abyss receives no summary request
