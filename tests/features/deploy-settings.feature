@vitest
Feature: Deploy settings
  Each Alchemy stage states what it deploys. A self-hosted stage reads every limit from the deploy command's
  environment, keeps the defaults for what is unset, and turns a limit off when it is set to 0.

  @scenario:deploy-settings-self-hosted-defaults @provenance:spec @i0
  Scenario: A self-hosted stage with nothing set keeps the default limits and cache
    When the production stage is resolved from an empty environment
    Then its Workers are named agris, agris-cache, agris-market and agris-catalog
    And its gateway binds no client rate limit and no global rate limit
    And its market Worker binds a Pearl Abyss rate limit of 100 per 10 seconds for the whole deployment and a concurrency of 6 per host
    And its gateway, cache and market Workers allow 50 subrequests and bind SUBREQUEST_LIMIT to 50
    And its gateway binds no cache or query variable, so it runs the default policy and limits
    And it answers on workers.dev and on no other hostname

  @scenario:deploy-settings-subrequest-limit @provenance:spec @i0
  Scenario: A self-hosted stage takes any positive subrequest limit
    When the production stage is resolved from this environment
      | variable         | value    |
      | SUBREQUEST_LIMIT | 20000000 |
    Then its gateway, cache and market Workers allow 20000000 subrequests and bind SUBREQUEST_LIMIT to 20000000

  @scenario:deploy-settings-self-hosted-overrides @provenance:spec @i0
  Scenario: A self-hosted stage sets or turns off each limit with its own variable
    When the production stage is resolved from this environment
      | variable                         | value             |
      | CLIENT_RATE_LIMIT_REQUESTS       | 30                |
      | GLOBAL_RATE_LIMIT_REQUESTS       | 300               |
      | GLOBAL_RATE_LIMIT_PERIOD_SECONDS | 10                |
      | PA_RATE_LIMIT_REQUESTS           | 0                 |
      | PA_MAX_CONCURRENT_REQUESTS       | 0                 |
      | CACHE_ENABLED                    | false             |
      | QUERY_MAX_DEPTH                  | 0                 |
      | GRAPHIQL                         | disabled          |
      | AGRIS_DOMAIN                     | agris.example.com |
    Then its gateway binds a client rate limit of 30 a minute and a global rate limit of 300 per 10 seconds
    And its gateway admits each client exactly 30 a minute and the deployment exactly 300 per 10 seconds
    And its market Worker binds no Pearl Abyss rate limit and a concurrency of 0
    And its gateway binds CACHE_ENABLED, QUERY_MAX_DEPTH and GRAPHIQL as they were set
    And it answers on agris.example.com as well as workers.dev

  @scenario:deploy-settings-refused @provenance:spec @i1
  Scenario: A setting the stage cannot use is refused before anything deploys
    When the production stage is resolved from each of these environments
      | variable                         | value      |
      | CLIENT_RATE_LIMIT_PERIOD_SECONDS | 30         |
      | CLIENT_RATE_LIMITS               | 10         |
      | PA_MAX_CONCURRENT_REQUESTS       | -1         |
      | CACHE_MARKET_ITEMS_MAX_AGE       | 60         |
      | QUERY_MAX_FIELDS                 | many       |
      | GRAPHIQL                         | off        |
      | AGRIS_DOMAIN                     | not a host |
      | SUBREQUEST_LIMIT                 | 0          |
      | SUBREQUEST_LIMITS                | 100        |
      | ADMISSION_CLIENT_REQUESTS        | 5          |
    Then each environment is refused with an error that names its variable

  @scenario:deploy-settings-demo @provenance:spec @i0
  Scenario: The demo stage protects Pearl Abyss whatever the environment holds
    When the demo stage is resolved from an environment that turns every limit off
    Then its Workers are named agris-demo, agris-demo-cache, agris-demo-market and agris-demo-catalog
    And its gateway binds a client rate limit of 10 a minute and a global rate limit of 120 a minute
    And its gateway admits each client exactly 10 a minute and the deployment exactly 120 a minute
    And its market Worker binds a Pearl Abyss rate limit of 20 a minute for the whole deployment and a concurrency of 2 per host
    And its gateway keeps every storable answer for at least 600 seconds and labels every response as the demo
