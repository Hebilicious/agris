@vitest
Feature: Catalog validation
  The shipped item catalog lists the same items in every locale, each under a native name, and a localized name may
  equal the English one only where the catalog says so.

  @scenario:catalog-validation-rules @provenance:spec @i1
  Scenario: A catalog is accepted only when every locale agrees with English and names are native
    When these catalogs are validated
      | case                                                  | outcome                  |
      | a well-formed catalog                                 | valid                    |
      | a German name equal to English that is listed         | valid                    |
      | a German name equal to English that is not listed     | unlisted-same-as-english |
      | a listed German name that differs from English        | unused-same-as-english   |
      | a French name in Korean script                        | wrong-script             |
      | German grades that differ from English                | english-reference        |
      | English items out of ID order                         | item-order               |
    Then every catalog meets its specified outcome
