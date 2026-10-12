@vitest-workers
Feature: Central Market Catalog Worker entrypoint
  The deployed Catalog Worker resolves its checked-in immutable catalog without a storage binding.

  @scenario:worker-entrypoint-catalog-memory @provenance:spec @i1
  Scenario: The real Catalog Worker resolves metadata from its bundled artifact
    When item 10006 is requested through the production Catalog Worker entrypoint
    Then the Catalog Worker response contains the bundled English metadata
