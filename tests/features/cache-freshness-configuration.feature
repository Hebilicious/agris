@vitest
Feature: Cache freshness configuration
  Each schema coordinate has a default freshness window. A deployment changes any one value with its own plain-text
  CACHE_* variable on the gateway: each window's fresh and stale-while-revalidate seconds, the stale-if-error window,
  the floor, the never-stored coordinates, and a switch that turns caching off. Every number accepts 0.

  @scenario:cache-freshness-defaults @provenance:spec @i1
  Scenario: Without a CACHE_ variable the gateway keeps the default policy
    When the gateway bindings set no CACHE_ variable beside the subgraphs and the smoke mode
    Then the policy is the default policy itself
    And the default policy has these windows
      | coordinate              | fresh    | stale while revalidating |
      | MarketItem.orderBook    | 5        | 5                        |
      | Market.registrations    | 5        | 5                        |
      | Market.items            | 60       | 70                       |
      | Item.marketSummary      | 60       | 70                       |
      | MarketItem.listings     | 60       | 70                       |
      | Market.catalog          | 30       | 30                       |
      | Market.hotItems         | 30       | 30                       |
      | MarketItem.priceHistory | 3600     | 3600                     |
      | Query.item              | 31536000 | 86400                    |
      | Query.items             | 31536000 | 86400                    |
      | Query.searchItems       | 31536000 | 86400                    |
    And the default policy keeps stored answers for 86400 seconds after a failed refresh
    And the default policy stores every coordinate and sets no floor

  @scenario:cache-freshness-nested-price @provenance:spec @i1
  Scenario: A price nested under a catalog field takes the price window
    When the gateway bindings set no CACHE_ variable beside the subgraphs and the smoke mode
    Then a market summary query is stored for 60 seconds and revalidates for 70
    And a search query is stored for 31536000 seconds and revalidates for 86400
    And a search query that selects market summaries is stored for 60 seconds and revalidates for 70

  @scenario:cache-freshness-never-stored @provenance:spec @i1
  Scenario: CACHE_NEVER_STORED keeps a coordinate out of the cache
    When the gateway bindings name Item.marketSummary in CACHE_NEVER_STORED
    Then a market summary query is never stored while a search query is still stored

  @scenario:cache-freshness-variable-names @provenance:spec @i1
  Scenario: Each defaulted coordinate has its own two variables
    When the cache settings are listed
    Then each coordinate's window is set by these variables
      | coordinate              | fresh                                       | stale while revalidating                                       |
      | MarketItem.orderBook    | CACHE_MARKET_ITEM_ORDER_BOOK_MAX_AGE_SECONDS    | CACHE_MARKET_ITEM_ORDER_BOOK_STALE_WHILE_REVALIDATE_SECONDS    |
      | Market.registrations    | CACHE_MARKET_REGISTRATIONS_MAX_AGE_SECONDS      | CACHE_MARKET_REGISTRATIONS_STALE_WHILE_REVALIDATE_SECONDS      |
      | Market.items            | CACHE_MARKET_ITEMS_MAX_AGE_SECONDS              | CACHE_MARKET_ITEMS_STALE_WHILE_REVALIDATE_SECONDS              |
      | Item.marketSummary      | CACHE_ITEM_MARKET_SUMMARY_MAX_AGE_SECONDS       | CACHE_ITEM_MARKET_SUMMARY_STALE_WHILE_REVALIDATE_SECONDS       |
      | MarketItem.listings     | CACHE_MARKET_ITEM_LISTINGS_MAX_AGE_SECONDS      | CACHE_MARKET_ITEM_LISTINGS_STALE_WHILE_REVALIDATE_SECONDS      |
      | Market.catalog          | CACHE_MARKET_CATALOG_MAX_AGE_SECONDS            | CACHE_MARKET_CATALOG_STALE_WHILE_REVALIDATE_SECONDS            |
      | Market.hotItems         | CACHE_MARKET_HOT_ITEMS_MAX_AGE_SECONDS          | CACHE_MARKET_HOT_ITEMS_STALE_WHILE_REVALIDATE_SECONDS          |
      | MarketItem.priceHistory | CACHE_MARKET_ITEM_PRICE_HISTORY_MAX_AGE_SECONDS | CACHE_MARKET_ITEM_PRICE_HISTORY_STALE_WHILE_REVALIDATE_SECONDS |
      | Query.item              | CACHE_QUERY_ITEM_MAX_AGE_SECONDS                | CACHE_QUERY_ITEM_STALE_WHILE_REVALIDATE_SECONDS                |
      | Query.items             | CACHE_QUERY_ITEMS_MAX_AGE_SECONDS               | CACHE_QUERY_ITEMS_STALE_WHILE_REVALIDATE_SECONDS               |
      | Query.searchItems       | CACHE_QUERY_SEARCH_ITEMS_MAX_AGE_SECONDS        | CACHE_QUERY_SEARCH_ITEMS_STALE_WHILE_REVALIDATE_SECONDS        |
    And the other settings are CACHE_ENABLED, CACHE_STALE_IF_ERROR_SECONDS, CACHE_MINIMUM_SECONDS and CACHE_NEVER_STORED

  @scenario:cache-freshness-override @provenance:spec @i2
  Scenario: CACHE_ variables change the window a query gets
    When the gateway bindings give Market.items 120 seconds fresh and 130 stale, and stale-if-error 600
    Then a price query is stored for 120 seconds and revalidates for 130
    And a catalog query keeps its default window
    And a stored price answer carries stale-if-error 600 in its Cache-Control header

  @scenario:cache-freshness-disabled @provenance:spec @i1
  Scenario: Zero and the switch turn caching off
    When the gateway bindings set CACHE_ENABLED to false
    Then a price query, a catalog query and an order book query are never stored
    When the gateway bindings set Market.items to 0 seconds fresh with a 600 second floor
    Then a price query is never stored
    And a catalog query is stored for at least 600 seconds
    When the gateway bindings set every window, stale-if-error and the floor to 0 and store every coordinate
    Then a price query is never stored
    And a market summary query is never stored

  @scenario:cache-freshness-refused @provenance:spec @i1
  Scenario: An invalid CACHE_ variable is refused
    When the gateway bindings carry these values
      | case                                    |
      | a CACHE_ variable that is not a setting |
      | a negative window                       |
      | a fractional window                     |
      | text that is not a number               |
      | a negative floor                        |
      | a never-stored coordinate not in schema |
      | a never-stored name that is not a field |
      | a switch that is not true or false      |
    Then every value is refused with an error that names its variable

  @scenario:cache-freshness-demo-floor @provenance:spec @i2
  Scenario: The demo configuration loads as a 600 second floor
    When the demo configuration's gateway bindings are loaded
    Then its policy is the default policy with a 600 second floor
