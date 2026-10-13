@vitest
Feature: Gateway invocation budget
  Each gateway execution spends its own subrequest budget on subgraph calls. One that runs out answers with a
  QUERY_BUDGET_EXCEEDED error, not as an unavailable subgraph, and executions that share an isolate, and so one gateway
  runtime, never share a budget.

  @scenario:gateway-budget-exceeded @provenance:spec @i0
  Scenario: A subgraph call beyond the budget is a query error
    When a catalog query executes with a subrequest budget of 0
    Then the answer is HTTP 200 with a QUERY_BUDGET_EXCEEDED error and no catalog call

  @scenario:gateway-budget-per-execution @provenance:spec @i0
  Scenario: Executions in one isolate get their own budgets
    When three catalog queries execute one after another and two at once, each with a subrequest budget of 1
    Then every answer has the item's name and the catalog was called five times
