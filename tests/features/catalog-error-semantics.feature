@vitest
Feature: Catalog error semantics
  A catalog query that cannot be answered says why only when the caller can fix it. A mistake in the query is a
  BAD_USER_INPUT field error whose message says what to change; any other failure is INTERNAL_SERVER_ERROR with one
  fixed message, so no internal text leaves the catalog subgraph.

  @scenario:catalog-client-input-errors @provenance:spec @i0
  Scenario: A mistake in a catalog argument is a BAD_USER_INPUT field error that says what is wrong
    When a caller asks the catalog subgraph for each of these
      | query                                                                                     | message starts with                                             |
      | { item(id: "abc") { name } }                                                              | Item ID must be a positive safe integer                         |
      | { items(ids: ["10006", "0"]) { name } }                                                   | Item ID must be a positive safe integer                         |
      | { _entities(representations: [{ __typename: "Item", id: "x", locale: "EN" }]) { __typename } } | Item ID must be a positive safe integer                    |
      | { searchItems(query: "...", locale: EN) { totalCount } }                                  | Folded Item Name query length must be between 3 and |
      | { searchItems(query: "blackstone", locale: EN, first: 101) { totalCount } }               | first must be between 1 and 100                                 |
    Then each answer is 200 with one BAD_USER_INPUT error whose message starts with its text

  @scenario:catalog-internal-errors-masked @provenance:spec @i0
  Scenario: An internal catalog failure reaches the caller as a closed error, not its internal text
    Given the catalog's item-name search returns a position outside the bundled artifact
    When a caller asks the catalog subgraph to search English item names for "blackstone"
    Then the answer is 200 with one INTERNAL_SERVER_ERROR at searchItems.items and the fixed catalog message
    And no error mentions the bundled artifact or the item position
