@vitest
Feature: Site deployment facts
  The website states the limits and cache freshness each deployment runs with, so what it says must be what is deployed.

  @scenario:site-states-deployed-limits @provenance:spec @i4
  Scenario: The site states the deployed limits
    When the self-hosted and demo stages of the deploy definition are loaded
    Then the site's self-hosted limits and cache freshness are what a self-hosted stage deploys with nothing set
    And the site's demo limits and cache freshness are what the demo stage deploys

  @scenario:site-lists-limit-settings @provenance:spec @i1
  Scenario: The site lists every limit as the setting that changes it
    When the self-hosted and demo stages of the deploy definition are loaded
    Then the site lists these limit settings
      | variable                           | self-hosted | demo | off with |
      | CLIENT_RATE_LIMIT_REQUESTS         | off         | 10   | 0        |
      | CLIENT_RATE_LIMIT_PERIOD_SECONDS   | 60          | 60   |          |
      | GLOBAL_RATE_LIMIT_REQUESTS         | off         | 120  | 0        |
      | GLOBAL_RATE_LIMIT_PERIOD_SECONDS   | 60          | 60   |          |
      | MARKET_CLIENT_LIMIT_REQUESTS       | off         | 10   | 0        |
      | MARKET_CLIENT_LIMIT_PERIOD_SECONDS | 60          | 60   |          |
      | PA_RATE_LIMIT_REQUESTS             | 100         | 20   | 0        |
      | PA_RATE_LIMIT_PERIOD_SECONDS       | 10          | 60   |          |
      | PA_MAX_CONCURRENT_REQUESTS         | 6           | 2    | 0        |
      | SUBREQUEST_LIMIT                   | 50          | 50   |          |
      | CACHE_MINIMUM_SECONDS              | off         | 600  | 0        |
      | QUERY_MAX_DEPTH                    | 8           | 8    | 0        |
      | QUERY_MAX_FIELDS                   | 150         | 150  | 0        |
      | QUERY_MAX_ALIASES                  | 15          | 15   | 0        |
      | QUERY_MAX_TYPE_EXPANSIONS          | 2           | 2    | 0        |
