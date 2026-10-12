@vitest
Feature: Catalog in-memory resolution
  Every Catalog query projects the same immutable artifact bundled into the deployed Worker.

  @scenario:direct-localized-item @provenance:integration @i1
  Scenario: Direct item lookup preserves localized metadata and nullable missing IDs
    When the catalog directly resolves item 10006 in English and French and an unknown item
    Then each supported locale returns its checked-in name and grade
    And the unknown direct item is null

  @scenario:ordered-detached-item-list @provenance:integration @i1
  Scenario: List lookup preserves caller order, unknown identities, and detached results
    When the catalog resolves items 10007, 999999999, 10006, and 10007 in English
    Then all four item identities remain in caller order with nullable unknown metadata
    And changing the returned data cannot change a later catalog response
