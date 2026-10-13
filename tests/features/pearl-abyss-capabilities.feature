@vitest
Feature: Pearl Abyss market protocol capabilities
  The Central Market protocol keeps every selected market fact while isolating callers from Pearl Abyss transports.

  @scenario:all-positional-fields @provenance:observed @i0
  Scenario: Every observed positional field survives normalization
    Given retained decoded payloads for all seven Pearl Abyss capabilities
    When the retained payloads are decoded through their capability requests
    Then summary item 10007 has stock 44, base price 76500, and 514774 trades
    And listing item 44195 has enhancement range 0 to 0, base price 1680000, stock 43483, 708081197 trades, price bounds 75000 to 5000000, and last sale 1670000 at 1787364852
    And catalog item 10003 has stock 1, 60715 trades, base price 72000, and category 1-1
    And the first order has price 74500, 0 sell orders, and 9 buy orders
    And the 90-point history starts 89 offsets from latest at 219302 and ends at offset 0 at 76326
    And hot item 784 has enhancement range 0 to 0, base price 166000, stock 0, 31223 trades, direction code 2, change 30000, price bounds 2670 to 190000, and last sale 166000 at 1692679415
    And registration item 705517 has enhancement 20, price 45800000000, and timestamp 1693064335

  @scenario:observed-huffman-body @provenance:observed @i0
  Scenario: An observed compressed bidding response is Huffman decoded before positional decoding
    Given the retained first-party compressed bidding response for item 10006
    When the compressed response is decoded through the order-book request
    Then its only order has price 371000, 0 sell orders, and 0 buy orders

  @scenario:unknown-shapes-fail-closed @provenance:minimal @i1
  Scenario: Unknown response shapes fail closed
    When a summary row contains an unrecognized extra position
    And a compressed response is truncated
    Then both Pearl Abyss responses are rejected as invalid upstream data

  @scenario:huffman-declared-output-ceiling @provenance:minimal @i0
  Scenario: A compressed response that declares more output than the decoder allows is rejected before decoding
    When a 32-byte compressed response declares 200000000 copies of one character
    Then the compressed response is rejected as invalid upstream data without being expanded
    And the decoder's output ceiling is eight times the Pearl Abyss response byte ceiling
    And a 32-byte compressed response that declares exactly that ceiling decodes in full
