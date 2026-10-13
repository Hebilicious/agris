@vitest
Feature: Agris Proxy response-cache policy
  Validated query selections determine freshness without exposing Cloudflare cache machinery to the protocol module.

  @scenario:repeated-request-cache-reuse @provenance:spec @i1
  Scenario: Repeated equivalent POST requests reuse one operation result
    Given a production-adjacent Central Market operation-result cache
    When the same catalog item is requested twice by POST
    Then both responses contain the same catalog item
    And the Agris Proxy executes the catalog query once and stores one operation result

  @scenario:cache-variable-separation @provenance:spec @i1
  Scenario: Canonical variable changes select distinct operation-result entries
    Given a production-adjacent Central Market operation-result cache
    When the same catalog query requests two different item IDs
    Then the responses contain their respective catalog items
    And the Agris Proxy executes both catalog queries and stores two operation results

  @scenario:graphql-errors-not-stored @provenance:spec @i0
  Scenario: GraphQL-error responses are never stored as operation results
    Given a production-adjacent Central Market operation-result cache
    When the same failing catalog query is requested twice
    Then both responses contain GraphQL errors with no-store caching
    And the Agris Proxy executes the failing query twice and stores no operation result

  @scenario:schema-aware-shortest-ttl @provenance:minimal @i1
  Scenario: The shortest active schema-coordinate TTL and revalidation window win
    Given the Central Market response-cache policy schema
    When a query selects aliased fields through named and inline fragments while five-second fields are skipped
    Then its selected response policy is 60 seconds, then 70 while revalidating, with one day of stale-on-error
    When the same query includes the five-second order book field
    Then its selected response policy is 5 seconds, then 5 while revalidating, with one day of stale-on-error

  @scenario:no-ttl-coordinate-no-store @provenance:minimal @i0
  Scenario: A query that selects no TTL-bearing coordinate is never stored
    Given the Central Market response-cache policy schema
    When a query selects no TTL-bearing coordinate
    Then its response policy is no-store
