@vitest
Feature: Pearl Abyss request safety
  Pearl Abyss work is coordinated within each graph execution and across concurrent Market Worker invocations.

  @scenario:shared-coordinator-deduplication @provenance:minimal @i1
  Scenario: Matching pending work is shared across coordinator callers
    When two callers submit the same pending request to the shared Pearl Abyss coordinator
    Then one execution satisfies both callers and a later request executes again

  @scenario:limiter-fail-closed @provenance:minimal @i0
  Scenario: Limiter denial and failure perform no outbound work
    When one Pearl Abyss request is denied and another limiter call fails
    Then each request fails as rate limited without a fetch or retry

  @scenario:six-connections @provenance:minimal @i0
  Scenario: Outbound Pearl Abyss work respects the shared connection ceiling
    When queued Pearl Abyss work competes with fresh work during a permit handoff
    Then at most six outbound requests are active throughout the handoff

  @scenario:budget-admission @provenance:minimal @i0
  Scenario: Planned work beyond the remaining invocation budget fails before issuance
    Given one Pearl Abyss subrequest remains in the invocation budget
    When two distinct summary batches are requested sequentially
    Then the second batch is rejected before a limiter call or fetch

  @scenario:typed-timeout @provenance:minimal @i1
  Scenario: A timed-out request is not retried
    When one admitted Pearl Abyss fetch times out
    Then it fails with the typed timeout after one permit and one fetch

  @scenario:agris-proxy-request-byte-ceiling @provenance:minimal @i0
  Scenario: Agris Proxy request buffering has a hard streaming byte ceiling
    When Agris Proxy request streams without a trustworthy length exceed the byte ceiling
    Then each Agris Proxy request is rejected and its stream is cancelled at the ceiling

  @scenario:agris-proxy-response-byte-ceiling @provenance:minimal @i0
  Scenario: Agris Proxy response buffering has a hard streaming byte ceiling
    When internal Agris Proxy response streams without a trustworthy length exceed the byte ceiling
    Then each Agris Proxy response is classified as HTTP 502 too large and its stream is cancelled at the ceiling

  @scenario:pearl-abyss-response-byte-ceiling @provenance:minimal @i0
  Scenario: Pearl Abyss response buffering has a hard streaming byte ceiling
    When a Pearl Abyss response stream with an understated length exceeds the byte ceiling
    Then the fetch fails as an invalid response and cancels the stream before decode

  @scenario:market-summary-operation-admission @provenance:spec @i0
  Scenario: Market summary admission normalizes and atomically bounds operation work
    When reordered duplicate summary keys race a seventh distinct key in one operation
    Then the duplicate reuses one of six admissions and the seventh is rejected
    And summary admission telemetry contains aggregate outcomes only
