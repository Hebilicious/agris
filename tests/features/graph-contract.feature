@vitest
Feature: Federated Central Market graph
  Authorized callers receive one concept-oriented graph result while Pearl Abyss facts and catalog metadata remain independently owned.

  @scenario:federated-market-catalog-query @provenance:minimal @i1
  Scenario: A market query composes market facts with catalog metadata
    Given the EU market reports item 44195 with base price 21400000000
    When an authorized caller queries that market item through the private Agris Proxy
    Then the graph returns the market price and catalog-owned item metadata in one nested result
    And the graph requests one Pearl Abyss summary batch and one catalog subgraph request

  @scenario:missing-catalog-preserves-market @provenance:minimal @i1
  Scenario: Missing catalog metadata does not erase resolved market facts
    Given the EU market reports unknown catalog item 999999999 with base price 21400000000
    When an authorized caller queries that market item through the private Agris Proxy
    Then the graph returns market facts with nullable missing catalog metadata
    And the graph requests one Pearl Abyss summary batch and one catalog subgraph request
