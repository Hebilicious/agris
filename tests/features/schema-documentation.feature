@vitest
Feature: Schema documentation
  GraphiQL's docs explorer explains every part of the public schema, so `schema:check` rejects a client schema with an
  undocumented element or a description that composition would drop.

  @scenario:schema-documentation-missing @provenance:spec @i1
  Scenario: An element without a description fails the documentation check
    Given a schema whose type, field, argument, enum value and input field each include one without a description
    When its documentation is checked
    Then the check names exactly those five elements
    And it does not ask for descriptions of the built-in scalars or the Federation helpers

  @scenario:schema-documentation-subgraph-conflict @provenance:spec @i1
  Scenario: Two subgraphs that describe a shared type differently fail the documentation check
    Given a market and a catalog subgraph that describe ItemLocale differently and Query the same way
    When their descriptions are compared
    Then the check names ItemLocale and nothing else
