@vitest
Feature: Pearl Abyss coordinators
  The market Worker's coordinators send each distinct Pearl Abyss request once, bound the work that waits, and hold
  each Pearl Abyss region to its own rate limit.

  @scenario:region-rate-limits-are-separate @provenance:minimal @i0
  Scenario: A region that has spent its Pearl Abyss rate limit does not throttle another region
    Given a deployment whose Pearl Abyss rate limit admits 1 request per period per region, counted per Cloudflare location
    When the EU coordinator spends its rate limit on a distinct Pearl Abyss request
    And the NA and MENA coordinators each receive a distinct Pearl Abyss request
    Then 3 requests reach Pearl Abyss and none fails as rate limited

  @scenario:region-rate-limit-holds @provenance:minimal @i0
  Scenario: A region beyond its own Pearl Abyss rate limit is refused
    Given a deployment whose Pearl Abyss rate limit admits 1 request per period per region, counted per Cloudflare location
    When the EU coordinator spends its rate limit on a distinct Pearl Abyss request
    And the EU coordinator receives another distinct Pearl Abyss request
    Then 1 request reaches Pearl Abyss and the other fails as rate limited

  @scenario:rate-limit-before-queue @provenance:minimal @i0
  Scenario: A distinct request the rate limit refuses never waits for an active slot
    Given a coordinator that runs one Pearl Abyss request at once and whose rate limit admits only the first
    When a second distinct request arrives while the first is still in flight
    Then the second fails as rate limited before the first settles

  @scenario:bounded-coordinator-queue @provenance:minimal @i0
  Scenario: Distinct requests past the coordinator's queue are refused without reaching Pearl Abyss
    Given a coordinator that runs one Pearl Abyss request at once
    When 102 distinct requests arrive while the first is still in flight
    Then one of them fails as queue full without reaching Pearl Abyss
    And once the first settles, the 101 admitted requests are answered

  @scenario:hashed-coordinator-keys @provenance:minimal @i0
  Scenario: Pending work is keyed by a digest of the request, not by its body
    When the coordinator key of a Pearl Abyss request is derived
    Then it is the hex SHA-256 of the request's URL and body

  @scenario:abandoned-sharer @provenance:minimal @i0
  Scenario: A caller that gives up does not fail the callers sharing its request
    When two callers share one pending Pearl Abyss request and the first gives up
    Then the second caller still receives the Pearl Abyss answer from one upstream request

  @scenario:last-sharer-cancels @provenance:minimal @i0
  Scenario: The upstream request is cancelled once every caller sharing it has given up
    When both callers sharing one pending Pearl Abyss request give up
    Then the upstream request is cancelled

  @scenario:coordinator-request-deadline @provenance:minimal @i0
  Scenario: A distinct request has 30 seconds from its arrival, waiting included, before the coordinator drops it
    Given a coordinator that runs one Pearl Abyss request at once
    When a second distinct request arrives while the first is still in flight
    And 30 seconds pass while Pearl Abyss holds the first
    Then both fail as timed out, the first's upstream call is cancelled, and the second never reaches Pearl Abyss

  @scenario:stalled-permit-refuses @provenance:minimal @i0
  Scenario: A permit the rate limiter does not answer within 5 seconds refuses the request
    Given a coordinator whose Pearl Abyss rate limiter answers only when released
    When a distinct request waits 5 seconds for its permit
    Then it fails as rate limited without reaching Pearl Abyss

  @scenario:abandoned-permit @provenance:minimal @i0
  Scenario: A distinct request whose every caller gives up while it waits for its permit is never sent
    Given a coordinator whose Pearl Abyss rate limiter answers only when released
    When the only caller of a distinct request gives up while it waits for its permit
    And the rate limiter then admits it
    Then it never reaches Pearl Abyss

  @scenario:abandoned-work-counts @provenance:minimal @i0
  Scenario: Work every caller has given up on still counts against the queue until it settles
    Given an in-flight coordinator that holds one distinct request at most and whose admission ignores cancellation
    When the only caller of a distinct request gives up while it is being admitted
    Then another distinct request fails as queue full until the abandoned one settles

  @scenario:unlimited-concurrency-is-bounded @provenance:minimal @i0
  Scenario: A coordinator without a concurrency limit still bounds the distinct requests it holds
    Given a coordinator whose PA_MAX_CONCURRENT_REQUESTS is 0
    When 1101 distinct requests arrive while Pearl Abyss holds every answer
    Then 1000 reach Pearl Abyss and one fails as queue full
