@vitest
Feature: Central Market scalar and enhancement semantics
  Market values remain truthful at the graph boundary instead of relying on lossy GraphQL defaults.

  @scenario:safe-integer-boundary @provenance:spec @i1
  Scenario: SafeInteger accepts only non-negative safe integers
    Then SafeInteger accepts zero and the maximum safe integer
    And SafeInteger rejects negative, fractional, unsafe, and non-finite numbers
