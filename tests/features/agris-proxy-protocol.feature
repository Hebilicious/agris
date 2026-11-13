@vitest
Feature: Agris Proxy request protocol
  The private Agris Proxy admits one validated read operation and gives equivalent requests one cache identity.

  @scenario:reject-disallowed-graphql-http @provenance:minimal @i0
  Scenario: Disallowed GraphQL-over-HTTP shapes fail closed
    Given a Central Market summary query
    When the Agris Proxy normalizes these disallowed requests
      | case                      | error                | status |
      | request array             | invalid-request      | 422    |
      | malformed JSON body       | malformed-json       | 400    |
      | missing content type      | invalid-content-type | 415    |
      | malformed content type    | invalid-content-type | 415    |
      | multipart body            | invalid-content-type | 415    |
      | variables array           | invalid-variables    | 422    |
      | prototype-shaped variable | invalid-variables    | 422    |
      | missing required variable | invalid-variables    | 422    |
      | malformed query document  | malformed-document   | 400    |
      | multiple operations       | invalid-document     | 422    |
      | mutation                  | operation-not-query  | 422    |
      | subscription              | operation-not-query  | 422    |
      | GET request               | invalid-method       | 405    |
      | unsupported method        | invalid-method       | 405    |
    Then every disallowed request is rejected with its specified protocol error and status

  @scenario:reject-persisted-hash-mismatch @provenance:minimal @i0
  Scenario: The application's approved-operation list cannot mislabel a query document
    When an approved-operation list assigns the summary query to another lowercase hash
    Then list validation rejects the hash and document mismatch
