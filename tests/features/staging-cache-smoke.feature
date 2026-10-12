@vitest
Feature: Deployed Agris Proxy cache
  The private staging Agris Proxy uses Cloudflare Workers Caching on its named inner entrypoint.

  @scenario:miss-hit-stale @provenance:cloudflare-staging @i1
  Scenario: A deployed cache generation serves live, fresh, and stale results accurately
    Given a local smoke caller bound remotely to the private deployed staging Agris Proxy smoke variant
    When the same thirty-second Central Market item-price query is requested twice
    Then the first response is MISS, live, and refresh-succeeded
    And the second response is HIT, cache-fresh, refresh-not-attempted, with Age visible
    When that entry expires and its refresh is forced to return HTTP 503
    Then the successful cached response is delivered as STALE, cache-stale, refresh-failed, with Age visible
