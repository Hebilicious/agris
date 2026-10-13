@vitest
Feature: Catalog Item Name search graph
  Catalog exposes exact localized Item Name search through both its direct subgraph and the composed Agris graph.

  @scenario:catalog-search-order-bound-count @provenance:spec @i1
  Scenario: Direct Catalog search orders, bounds, counts, and defaults exactly
    When Catalog searches English Item Names for "blackstone" with first 2
    Then it returns Black Stone before Black Stone Powder and reports 4 total matches
    When Catalog searches English Item Names for "stone" without first
    Then it returns the default 50 Items and reports 166 total matches

  @scenario:catalog-search-bad-user-input @provenance:spec @i1
  Scenario: Invalid Catalog search inputs have no partial search data
    When Catalog searches with a punctuation-only query
    Then the Catalog response is BAD_USER_INPUT with no partial data
    When Catalog searches with first 101
    Then the Catalog response is BAD_USER_INPUT with no partial data
