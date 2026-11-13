@vitest
Feature: Public query protocol
  A public deployment admits only queries of bounded size and may hold storable results longer than the schema asks.

  @scenario:public-query-size-limits @provenance:spec @i0
  Scenario: Queries beyond the public size limits are rejected before they run
    Given a request protocol with a depth limit of 3, a field limit of 6 and an alias limit of 2
    When the protocol normalizes these queries
      | case                         | outcome             | status |
      | within every limit           | accepted            |        |
      | nested four fields deep      | query-too-complex   | 422    |
      | deep through a fragment      | query-too-complex   | 422    |
      | seven fields                 | query-too-complex   | 422    |
      | seven fields through spreads | query-too-complex   | 422    |
      | three aliases                | query-too-complex   | 422    |
      | mutation                     | operation-not-query | 422    |
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
      | case                         | outcome         | status |
      | inline query                 | body            |        |
      | persisted id                 | body            |        |
      | unknown persisted id         | invalid-request | 422    |
      | both query and id            | invalid-request | 422    |
      | neither query nor id         | invalid-request | 422    |
      | repeated variables           | invalid-request | 422    |
      | unexpected parameter         | invalid-request | 422    |
      | variables that are not JSON  | malformed-json  | 400    |
      | extensions object            | body            |        |
      | extensions that are not JSON | malformed-json  | 400    |
      | empty optional parameters    | body            |        |
      | query string over the limit  | url-too-long    | 414    |
    Then every query string meets its specified outcome
    And the persisted id reads as the inline query with the same variables
    And empty optional parameters read as if they were absent

  @scenario:public-introspection-limits @provenance:spec @i1
  Scenario: Introspection is admitted as deep as GraphiQL needs but cannot recurse through the schema
    Given the public request protocol
    When the protocol normalizes these introspection queries
      | case                                       | outcome           | status |
      | GraphiQL's introspection query             | accepted          |        |
      | fields of the types of fields              | query-too-complex | 422    |
      | the same recursion beside a regular field  | query-too-complex | 422    |
      | an introspection field beside a deep query | query-too-complex | 422    |
    Then every query meets its specified outcome

  @scenario:public-extensions @provenance:spec @i1
  Scenario: The public protocol ignores body properties it does not understand, as GraphQL over HTTP requires
    When a query with an empty extensions object is sent to the public and to the private protocol
    Then the public protocol accepts it and the private protocol refuses it
    And the public protocol refuses extensions that are not an object
    When a query with a property GraphQL over HTTP does not define is sent to the public and to the private protocol
    Then the public protocol ignores the property and the private protocol refuses it
    And both protocols read null variables as no variables

  @scenario:public-query-limit-settings @provenance:spec @i1
  Scenario: A deployment sets or lifts each query limit with its own QUERY_ variable
    When the query limits are read from these gateway bindings
      | bindings                                                       | depth | fields | aliases | type expansions |
      | none                                                           | 8     | 150    | 15      | 2               |
      | QUERY_MAX_DEPTH=3                                              | 3     | 150    | 15      | 2               |
      | QUERY_MAX_DEPTH=0                                              | none  | 150    | 15      | 2               |
      | QUERY_MAX_FIELDS=0 QUERY_MAX_ALIASES=0 QUERY_MAX_TYPE_EXPANSIONS=0 | 8 | none   | none    | none            |
    Then each set of bindings yields its limits
    And a query nested twenty fields deep is refused by default and accepted once QUERY_MAX_DEPTH is 0
    And introspection that recurses through the schema is refused by default and accepted once QUERY_MAX_TYPE_EXPANSIONS is 0
    And a misspelt, a negative and a fractional query limit are each refused with an error naming the variable
