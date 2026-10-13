@vitest
Feature: Deployed Agris Proxy cache
  The smoke stage deploys the private gateway entrypoint the way a host does, and it uses Cloudflare Workers Caching on
  its named inner entrypoint.

  @scenario:miss-hit-stale @provenance:cloudflare-staging @i1
  Scenario: A deployed cache generation serves live, fresh, and stale results accurately
    Given the smoke stage's caller, bound to its private deployed Agris Proxy
    When the same thirty-second Central Market item-price query is requested twice
    Then the first response is MISS, live, and refresh-succeeded
    And the second response is HIT, cache-fresh, refresh-not-attempted, with Age visible
    When that entry expires and its refresh is forced to return HTTP 503
    Then the successful cached response is delivered as STALE, cache-stale, refresh-failed, with Age visible
