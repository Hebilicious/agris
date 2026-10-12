@vitest
Feature: Public query protocol
  A public deployment admits only queries of bounded size and may hold storable results longer than the schema asks.

  @scenario:public-query-size-limits @provenance:spec @i0
  Scenario: Queries beyond the public size limits are rejected before they run
    Given a request protocol with a depth limit of 3, a field limit of 6 and an alias limit of 2
    When the protocol normalizes these queries
      | case                         | outcome           |
      | within every limit           | accepted          |
      | nested four fields deep      | query-too-complex |
      | deep through a fragment      | query-too-complex |
      | seven fields                 | query-too-complex |
      | seven fields through spreads | query-too-complex |
      | three aliases                | query-too-complex |
      | mutation                     | operation-not-query |
    Then every query meets its specified outcome

  @scenario:public-freshness-floor @provenance:spec @i0
  Scenario: A freshness floor lengthens storable results only when it is configured
    When the same queries are normalized with and without a freshness floor of 600 seconds
    Then without the floor a 60 second result stays fresh for 60 seconds and revalidates for 70
    And with the floor it stays fresh for 600 seconds and revalidates for 600
    And with the floor a result the schema keeps for a year still keeps for a year
    And with the floor an uncacheable result stays uncacheable

  @scenario:public-get-parameters @provenance:spec @i1
  Scenario: A GET query string becomes the POST body only when its parameters are well formed
    Given a deployment whose only persisted operation is the example market query
    When these GET query strings are read
      | case                       | outcome           |
      | inline query               | body              |
      | persisted id               | body              |
      | unknown persisted id       | invalid-request   |
      | both query and id          | invalid-request   |
      | neither query nor id       | invalid-request   |
      | repeated variables         | invalid-request   |
      | unexpected parameter       | invalid-request   |
      | variables that are not JSON | invalid-variables |
    Then every query string meets its specified outcome
    And the persisted id reads as the inline query with the same variables

  @scenario:public-introspection-limits @provenance:spec @i1
  Scenario: Introspection is admitted as deep as GraphiQL needs but cannot recurse through the schema
    Given the public request protocol
    When the protocol normalizes these introspection queries
      | case                                         | outcome           |
      | GraphiQL's introspection query               | accepted          |
      | fields of the types of fields                | query-too-complex |
      | the same recursion beside a regular field    | query-too-complex |
      | an introspection field beside a deep query   | query-too-complex |
    Then every query meets its specified outcome

  @scenario:public-extensions @provenance:spec @i1
  Scenario: Only the public protocol accepts the GraphQL-over-HTTP extensions object
    When a query with an empty extensions object is sent to the public and to the private protocol
    Then the public protocol accepts it and the private protocol refuses it
    And the public protocol refuses extensions that are not an object
