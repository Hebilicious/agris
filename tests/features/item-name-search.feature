@vitest
Feature: Exact Item Name search
  The Economy catalog finds localized Item Names by their exact folded substring without fuzzy substitutions.

  @scenario:folded-exact-item-name-search @provenance:spec @i2
  Scenario: Item Name search applies the confirmed folding rules
    Then these locale-scoped queries return at least one exact substring match
      | locale | query      |
      | EN     | Advance    |
      | FR     | epee       |
      | EN     | blackstone |
      | EN     | chiros     |
    And the English query "shiro" returns no Chiro Item Name
