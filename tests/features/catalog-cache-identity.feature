@vitest
Feature: Catalog cache identity
  The gateway caches catalog answers for up to a year, so every cache key carries a checksum of what the catalog
  answers: the data the release ships and the catalog subgraph's code that folds, matches and ranks names. A release
  that changes either stores its answers under new keys.

  @scenario:catalog-change-changes-cache-key @provenance:spec @i0
  Scenario: Renaming one item changes the cache key of every query
    When a catalog query's cache key is computed for the shipped catalog and for one with an English name changed
    Then the two keys differ
    And the gateway's cache keys use the shipped catalog's identity

  @scenario:catalog-code-change-changes-cache-key @provenance:spec @i0
  Scenario: Changing how the catalog searches changes the cache key of every query
    When a catalog query's cache key is computed for the shipped catalog code and for one with its search code changed
    Then the two keys differ
