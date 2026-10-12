@vitest
Feature: Agris Proxy request protocol
  The private Agris Proxy admits one validated read operation and gives equivalent requests one cache identity.

  @scenario:reject-disallowed-graphql-http @provenance:minimal @i0
  Scenario: Disallowed GraphQL-over-HTTP shapes fail closed
    Given a Central Market summary query
    When the Agris Proxy normalizes these disallowed requests
      | case                      | error                       |
      | request array             | invalid-request             |
      | malformed JSON body       | invalid-request             |
      | missing content type      | invalid-content-type        |
      | malformed content type    | invalid-content-type        |
      | multipart body            | invalid-content-type        |
      | variables array           | invalid-variables           |
      | prototype-shaped variable | invalid-variables           |
      | missing required variable | invalid-variables           |
      | malformed query document  | invalid-document            |
      | multiple operations       | invalid-document            |
      | mutation                  | operation-not-query         |
      | subscription              | operation-not-query         |
      | GET request               | invalid-method              |
      | unsupported method        | invalid-method              |
    Then every disallowed request is rejected with its specified protocol error

  @scenario:reject-persisted-hash-mismatch @provenance:minimal @i0
  Scenario: The application's approved-operation list cannot mislabel a query document
    When an approved-operation list assigns the summary query to another lowercase hash
    Then list validation rejects the hash and document mismatch
