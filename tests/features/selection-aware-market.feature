@vitest
Feature: Selection-aware Central Market reads
  Market queries preserve caller meaning while issuing only the normalized market work selected by the query.

  @scenario:ordered-summary-batch @provenance:minimal @i1
  Scenario: One summary batch preserves caller order, duplicates, and unlisted items
    Given market summaries exist for items 10006 and 10007
    When a caller requests summary IDs 10007, 99999, 10006, and 10007
    Then the market items remain in caller order with 99999 marked unlisted
    And the reader receives one distinct summary batch for 10006, 10007, and 99999
    And an omitted detail field causes no detail read
    And observedAt is captured immediately before that summary read
