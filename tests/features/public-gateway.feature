@vitest-workers
Feature: Public gateway
  A public deployment answers GraphQL over HTTP, admits callers through its rate limits, and serves its site for
  every other path. Its rate-limit bindings check every request, at the Cloudflare location, with no round trip. Its
  exact market admission is a token bucket in one Durable Object per client, so a burst cannot outrun it the way it
  outruns the bindings, and an execution asks it only when it is about to call the market subgraph: a cache hit, a
  catalog-only query, a health check and a preflight never do.

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

  @scenario:public-gateway-cache-hit-not-admitted @provenance:spec @i0
  Scenario: A cache hit makes no admission request, and a market cache miss exactly one
    Given a public gateway behind an edge cache that admits each client exactly 3 market executions a minute
    When one client asks for the same market item twice
    Then the first answer is a cache miss and the second a cache hit, both with the Pearl Abyss item
    And the admission objects were asked 1 time

  @scenario:public-gateway-market-miss-admitted-once @provenance:spec @i1
  Scenario: A market cache miss that calls the market subgraph twice is admitted once
    Given a public gateway behind an edge cache that admits each client exactly 3 market executions a minute
    When one client asks in one query for an NA market item and for a catalog item's EU market summary
    Then the answer carries the market item and the market summary
    And the admission objects were asked 1 time

  @scenario:public-gateway-catalog-only-not-admitted @provenance:spec @i0
  Scenario: A catalog-only query makes no admission request
    Given a public gateway behind an edge cache that admits each client exactly 1 market execution a minute
    When one client asks for the names of 3 different items, one query each
    Then every answer is the item's catalog name
    And the admission objects were asked 0 times

  @scenario:public-gateway-exact-market-admission @provenance:spec @i0
  Scenario: A parallel burst of market misses from one client is held to its exact allowance
    Given a public gateway behind an edge cache that admits each client exactly 3 market executions a minute
    When one client sends 8 queries for different market items at once
    Then 3 queries are answered and 5 are answered 429 RATE_LIMITED with a Retry-After
    And another client's market query is still answered

  @scenario:public-gateway-uncacheable-market-admission @provenance:spec @i1
  Scenario: An uncacheable market query is admitted where it executes
    Given a public gateway that stores nothing and admits each client exactly 2 market executions a minute
    When one client sends 3 queries for different market items, one after the other
    Then 2 queries are answered and 1 is answered 429 RATE_LIMITED with a Retry-After

  @scenario:public-gateway-refused-miss-serves-stale @provenance:spec @i0
  Scenario: A market miss the admission refuses serves the stale cached answer when the edge keeps one
    Given a public gateway behind an edge cache that admits each client exactly 1 market execution a minute
    When one client's market item answer is cached and expires, and the client asks for it again
    Then the gateway answers 200 with the cached market item, served stale because its refresh failed
    When the client asks for a market item the edge has never stored
    Then the query is answered 429 RATE_LIMITED with a Retry-After

  @scenario:public-gateway-admission-survives-eviction @provenance:spec @i0
  Scenario: A spent allowance stays spent when its admission object is evicted
    Given a public gateway behind an edge cache that admits each client exactly 2 market executions a minute
    When one client spends its allowance and its admission object is evicted
    Then the client's next market query is answered 429 RATE_LIMITED with a Retry-After

  @scenario:public-gateway-admission-rate-change @provenance:spec @i1
  Scenario: Changing a deployment's rate does not refill a spent allowance
    Given a public gateway behind an edge cache that admits each client exactly 2 market executions a minute
    When one client spends its allowance and the deployment raises the limit to 5 market executions a minute
    Then the client's next market query is answered 429 RATE_LIMITED with a Retry-After

  @scenario:public-gateway-ipv6-client-admission @provenance:spec @i1
  Scenario: Addresses in one IPv6 /64 share one client allowance
    Given a public gateway behind an edge cache that admits each client exactly 2 market executions a minute
    When two addresses in one IPv6 /64 send 2 market queries each, one after the other
    Then 2 queries are answered and 2 are answered 429 RATE_LIMITED with a Retry-After

  @scenario:public-gateway-binding-every-path @provenance:spec @i1
  Scenario: Health checks, preflights and the site pass the rate-limit binding, and never the admission objects
    When a caller over the client rate limit requests the health path and the site's home page
    Then the gateway answers each one 429 for the client scope with Retry-After 60 and the deploy guide
    When a caller over the client rate limit sends a CORS preflight
    Then the gateway answers it 204 allowing GET, POST and OPTIONS, for the browser not to remember
    When a caller within the client rate limit requests the health path, a CORS preflight and GraphiQL on a gateway that admits market executions exactly
    Then each one is answered and the admission objects were asked 0 times

  @scenario:public-gateway-admission-fails-closed @provenance:spec @i1
  Scenario: An execution whose admission cannot answer refuses its market calls instead of admitting them
    When a caller sends a market query to a public gateway whose admission object fails
    Then the query is answered 429 RATE_LIMITED with Retry-After 5
    When a caller sends a request to a public gateway that sets an exact market limit but binds no admission object
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
    And the page may run only its own scripts and the pinned GraphiQL release, and no other site may frame it
    When GraphiQL sends its introspection query
    Then the gateway answers with the client schema
    And every type, field, argument, enum value and input field in it carries the client schema's description
    When a browser opens the GraphQL path on a gateway with GraphiQL disabled
    Then the gateway answers that a query is required instead of GraphiQL

  @scenario:public-gateway-graphiql-inline-scripts @provenance:spec @i1
  Scenario: The GraphiQL policy allows every inline script by its hash, however its tag is written
    When the GraphiQL policy is made for a page whose inline scripts carry attributes beside an external script
    Then every inline script on that page has its hash in the policy, and nothing else is hashed

  @scenario:public-gateway-graphiql-render-retry @provenance:spec @i2
  Scenario: A GraphiQL page that failed to render is rendered again on the next request
    When a GraphiQL page fails to render once and is then requested again
    Then the second request renders the page afresh and gets it

  @scenario:public-gateway-security-headers @provenance:spec @i1
  Scenario: Every public response tells browsers not to sniff it or leak the referrer
    When the same market item is requested from the public gateway by POST, by GET and by persisted id
    Then every response forbids content sniffing and sends no referrer

  @scenario:public-gateway-graphiql-link @provenance:spec @i3
  Scenario: A shared link's GraphiQL page does not carry the example query
    When a browser opens a link to the GraphQL path that carries a query
    Then the gateway does not replace the link's query with its example

  @scenario:public-gateway-unlimited @provenance:spec @i1
  Scenario: A deployment that binds no rate limiter limits no caller
    When one caller sends three market item requests to a public gateway that binds no rate limiter
    Then every request returns the Pearl Abyss item
