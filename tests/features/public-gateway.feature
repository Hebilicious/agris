@vitest-workers
Feature: Public gateway
  A public deployment answers GraphQL over HTTP, admits callers through its rate limits, and serves its site for
  every other path.

  @scenario:public-gateway-query-forms @provenance:spec @i1
  Scenario: POST, GET and a persisted id return the same market item to any origin
    When the same market item is requested from the public gateway by POST, by GET and by persisted id
    Then all three responses return the Pearl Abyss item with its catalog name
    And every response allows any origin

  @scenario:public-gateway-browser-persisted-get @provenance:spec @i1
  Scenario: A browser asking for a persisted id gets data, not GraphiQL
    When a browser requests the same market item by persisted id
    Then the gateway answers with the item's JSON data rather than GraphiQL

  @scenario:public-gateway-preflight @provenance:spec @i1
  Scenario: A browser preflight is answered without running a query
    When a browser sends a CORS preflight for the GraphQL path
    Then the gateway answers 204 allowing GET, POST and OPTIONS with a Content-Type header

  @scenario:public-gateway-rate-limits @provenance:spec @i0
  Scenario: A rate-limited caller is told to retry later or deploy their own
    When a caller is over the client rate limit
    Then the gateway answers 429 for the client scope with Retry-After 60 and the deploy guide
    When a caller is within the client rate limit while the deployment is over the global rate limit
    Then the gateway answers 429 for the global scope with Retry-After 60 and the deploy guide
    And no rate-limited request reached Pearl Abyss

  @scenario:public-gateway-demo-and-assets @provenance:spec @i2
  Scenario: A demo deployment labels every response and serves its site
    Given a public gateway with a demo notice and a static site
    When a caller requests the health path, the site's home page and the GraphQL path
    Then every response carries the demo notice
    And the health path reports ok and the home page comes from the site
    When the same paths are requested from a public gateway without a site
    Then the home page is a JSON 404 that points to the GraphQL path

  @scenario:public-gateway-graphiql @provenance:spec @i2
  Scenario: A browser opening the GraphQL path gets GraphiQL, which can load the documented schema
    When a browser opens the GraphQL path
    Then the gateway answers with the GraphiQL page, showing Agris's icon
    When GraphiQL sends its introspection query
    Then the gateway answers with the client schema
    And every type, field, argument, enum value and input field in it carries the client schema's description
    When a browser opens the GraphQL path on a gateway with GraphiQL disabled
    Then the gateway answers that a query is required instead of GraphiQL

  @scenario:public-gateway-graphiql-link @provenance:spec @i3
  Scenario: A shared link's GraphiQL page does not carry the example query
    When a browser opens a link to the GraphQL path that carries a query
    Then the gateway does not replace the link's query with its example

  @scenario:public-gateway-unlimited @provenance:spec @i1
  Scenario: A deployment that binds no rate limiter limits no caller
    When one caller sends three market item requests to a public gateway that binds no rate limiter
    Then every request returns the Pearl Abyss item
