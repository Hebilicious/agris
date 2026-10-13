@vitest-workers
Feature: Public gateway
  A public deployment answers GraphQL over HTTP, admits callers through its rate limits, and serves its site for
  every other path. Its exact limits are token buckets in one Durable Object per client and one for the whole
  deployment, so a burst cannot outrun them the way it outruns Cloudflare's per-location rate-limit bindings.

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

  @scenario:public-gateway-exact-client-admission @provenance:spec @i0
  Scenario: A parallel burst from one client is held to its exact allowance
    Given a public gateway that admits each client exactly 3 requests a minute
    When one client sends 8 requests at once
    Then 3 requests are answered and 5 are answered 429 for the client scope with a Retry-After
    And another client is still answered

  @scenario:public-gateway-admission-survives-eviction @provenance:spec @i0
  Scenario: A spent allowance stays spent when its admission object is evicted
    Given a public gateway that admits each client exactly 2 requests a minute
    When one client spends its allowance and its admission object is evicted
    Then the client's next request is answered 429 for the client scope with a Retry-After

  @scenario:public-gateway-admission-rate-change @provenance:spec @i1
  Scenario: Changing a deployment's rate does not refill a spent allowance
    Given a public gateway that admits each client exactly 2 requests a minute
    When one client spends its allowance and the deployment raises the limit to 5 requests a minute
    Then the client's next request is answered 429 for the client scope with a Retry-After

  @scenario:public-gateway-ipv6-client-admission @provenance:spec @i1
  Scenario: Addresses in one IPv6 /64 share one client allowance
    Given a public gateway that admits each client exactly 2 requests a minute
    When two addresses in one IPv6 /64 send 2 requests each, one after the other
    Then 2 requests are answered and 2 are answered 429 for the client scope with a Retry-After

  @scenario:public-gateway-exact-global-admission @provenance:spec @i0
  Scenario: A parallel burst from many clients is held to the deployment's exact allowance
    Given a public gateway that admits the whole deployment exactly 4 requests a minute
    When 10 clients send one request each at once
    Then 4 requests are answered and 6 are answered 429 for the global scope with a Retry-After

  @scenario:public-gateway-admission-every-path @provenance:spec @i1
  Scenario: Health checks, preflights and the site spend the same allowance as queries
    When a caller over the client rate limit requests the health path and the site's home page
    Then the gateway answers each one 429 for the client scope with Retry-After 60 and the deploy guide
    When a caller over its exact client allowance requests the health path
    Then the gateway answers each one 429 for the client scope with a Retry-After

  @scenario:public-gateway-refused-preflight @provenance:spec @i1
  Scenario: A refused preflight lets the browser read the refusal of its real request
    Given a public gateway that admits each client exactly 2 requests a minute
    When one client sends 2 CORS preflights and then a query
    Then the gateway answers both preflights 204 and the query 429 for the client scope with a Retry-After
    When the client sends another CORS preflight
    Then the gateway answers it 204 allowing GET, POST and OPTIONS, for the browser not to remember
    When a caller over the client rate limit sends a CORS preflight
    Then the gateway answers it 204 allowing GET, POST and OPTIONS, for the browser not to remember

  @scenario:public-gateway-admission-fails-closed @provenance:spec @i1
  Scenario: A gateway whose admission cannot answer refuses callers instead of admitting all of them
    When a caller sends a request to a public gateway whose admission object fails
    Then the gateway answers 503 with code ADMISSION_UNAVAILABLE and a Retry-After
    When a caller sends a request to a public gateway that sets an exact limit but binds no admission object
    Then the request fails instead of being admitted

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
