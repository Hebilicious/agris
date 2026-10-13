import assert from "node:assert/strict";

import fc from "fast-check";
import {
  PEARL_ABYSS_ITEM_LOCALES,
  type PearlAbyssItemLocale,
} from "../../packages/pearl-abyss/src/protocol/locale-descriptor.ts";
import { generatedCatalogSearchArtifact } from "../../packages/catalog-subgraph/dist/generated-catalog-search-artifact.js";
import {
  catalogItemNameSearch,
  foldCatalogItemName,
  type CatalogItemNameSearchSuccess,
} from "../../packages/catalog-subgraph/dist/item-name-search.js";
import type { ExecutableNativeProperty } from "../support/manifest.ts";

const generatorVersion = "fast-check@4.9.0";
const seed = 20_260_831;
const runsPerLocale = 100;

interface SearchQuery {
  readonly locale: PearlAbyssItemLocale;
  readonly query: string;
}

export const nativeProperty: ExecutableNativeProperty = {
  id: "central-market/item-name-search-index-equals-linear-scan",
  testName: `Indexed Item Name search equals a linear scan for every locale (${generatorVersion}, seed ${seed}, ${runsPerLocale} runs per locale, shrinking enabled)`,
  execute: () => {
    for (const locale of PEARL_ABYSS_ITEM_LOCALES) {
      assertSearchEqualsLinear(locale, "🦄🦄🦄", 1);
      assertSearchEqualsLinear(locale, "aaaa", 100);
      assertSearchEqualsLinear(locale, firstThreeCodePoints(locale), 1);
      assertSearchEqualsLinear(locale, firstThreeCodePoints(locale), 100);

      const searchablePositions = stringColumnValues(generatedCatalogSearchArtifact.searchKeys[locale])
        .map((searchKey, position) => ({ position, length: Array.from(searchKey).length }))
        .filter(({ length }) => length >= 3);
      assert.ok(searchablePositions.length > 0);

      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: searchablePositions.length - 1 }),
          fc.nat(),
          fc.nat(),
          fc.integer({ min: 1, max: 100 }),
          (searchableIndex, startSeed, lengthSeed, first) => {
            const selected = searchablePositions[searchableIndex];
            assert.ok(selected);
            const key = Array.from(generatedCatalogSearchArtifact.searchKeys[locale].valueAt(selected.position) ?? "");
            const start = startSeed % (key.length - 2);
            const availableLength = key.length - start;
            const length = 3 + (lengthSeed % (availableLength - 2));
            assertSearchEqualsLinear(locale, key.slice(start, start + length).join(""), first);
          },
        ),
        { seed, numRuns: runsPerLocale },
      );
    }

    assertSearchEqualsLinear("EN", "blackstone", 100);
    const blackStoneMatches = linearMatchingPositions("EN", foldCatalogItemName("blackstone", "EN"));
    assert.deepEqual(
      [...new Set(blackStoneMatches.map((position) => matchCategory(searchKey("EN", position), "blackstone")))],
      [0, 1, 2],
    );
    const duplicate = duplicateSearchKey();
    assertSearchEqualsLinear(duplicate.locale, duplicate.query, 100);
    const duplicateItemIds = linearMatchingPositions(duplicate.locale, duplicate.query)
      .filter((position) => searchKey(duplicate.locale, position) === duplicate.query)
      .map((position) => generatedCatalogSearchArtifact.itemIds.valueAt(position));
    assert.deepEqual(
      duplicateItemIds,
      [...duplicateItemIds].sort((left, right) => (left ?? 0) - (right ?? 0)),
    );

    const maximum = maximumSearchKey();
    assert.equal(Array.from(maximum.query).length, generatedCatalogSearchArtifact.maxFoldedItemNameCodePoints);
    assertSearchEqualsLinear(maximum.locale, maximum.query, 100);

    for (const { query, foldedQueryLength } of [
      { query: ".", foldedQueryLength: 0 },
      { query: "x", foldedQueryLength: 1 },
      { query: "ab", foldedQueryLength: 2 },
    ]) {
      assert.deepEqual(catalogItemNameSearch.search({ locale: "EN", query, first: 1 }), {
        ok: false,
        code: "QUERY_LENGTH_OUT_OF_RANGE",
        foldedQueryLength,
        minimum: 3,
        maximum: generatedCatalogSearchArtifact.maxFoldedItemNameCodePoints,
      });
    }
    assert.deepEqual(
      catalogItemNameSearch.search({
        locale: "EN",
        query: "x".repeat(generatedCatalogSearchArtifact.maxFoldedItemNameCodePoints + 1),
        first: 1,
      }),
      {
        ok: false,
        code: "QUERY_LENGTH_OUT_OF_RANGE",
        foldedQueryLength: generatedCatalogSearchArtifact.maxFoldedItemNameCodePoints + 1,
        minimum: 3,
        maximum: generatedCatalogSearchArtifact.maxFoldedItemNameCodePoints,
      },
    );
    for (const first of [0, 101, 1.5, Number.NaN]) {
      assert.deepEqual(catalogItemNameSearch.search({ locale: "EN", query: "stone", first }), {
        ok: false,
        code: "FIRST_OUT_OF_RANGE",
        received: first,
        minimum: 1,
        maximum: 100,
      });
    }
  },
};

function assertSearchEqualsLinear(locale: PearlAbyssItemLocale, query: string, first: number): void {
  const actual = catalogItemNameSearch.search({ locale, query, first });
  assert.equal(actual.ok, true, `${locale} ${JSON.stringify(query)} should be accepted`);
  if (!actual.ok) return;
  assert.deepEqual(actual, linearSearch(locale, query, first));
}

function linearSearch(locale: PearlAbyssItemLocale, query: string, first: number): CatalogItemNameSearchSuccess {
  const foldedQuery = foldCatalogItemName(query, locale);
  const itemPositions = linearMatchingPositions(locale, foldedQuery);
  return { ok: true, itemPositions: itemPositions.slice(0, first), totalCount: itemPositions.length };
}

function linearMatchingPositions(locale: PearlAbyssItemLocale, foldedQuery: string): number[] {
  return stringColumnValues(generatedCatalogSearchArtifact.searchKeys[locale])
    .map((searchKey, position) => ({ position, searchKey }))
    .filter(({ searchKey }) => searchKey.includes(foldedQuery))
    .sort((left, right) => compareMatches(left, right, foldedQuery))
    .map(({ position }) => position);
}

function compareMatches(
  left: Readonly<{ position: number; searchKey: string }>,
  right: Readonly<{ position: number; searchKey: string }>,
  query: string,
): number {
  const categoryDifference = matchCategory(left.searchKey, query) - matchCategory(right.searchKey, query);
  if (categoryDifference !== 0) return categoryDifference;
  const nameDifference = compareStrings(left.searchKey, right.searchKey);
  if (nameDifference !== 0) return nameDifference;
  return (
    (generatedCatalogSearchArtifact.itemIds.valueAt(left.position) ?? Number.MAX_SAFE_INTEGER) -
    (generatedCatalogSearchArtifact.itemIds.valueAt(right.position) ?? Number.MAX_SAFE_INTEGER)
  );
}

function matchCategory(searchKey: string, query: string): number {
  if (searchKey === query) return 0;
  if (searchKey.startsWith(query)) return 1;
  return 2;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function firstThreeCodePoints(locale: PearlAbyssItemLocale): string {
  const key = stringColumnValues(generatedCatalogSearchArtifact.searchKeys[locale]).find(
    (candidate) => Array.from(candidate).length >= 3,
  );
  assert.ok(key);
  return Array.from(key).slice(0, 3).join("");
}

function maximumSearchKey(): SearchQuery {
  let maximum: SearchQuery | undefined;
  for (const locale of PEARL_ABYSS_ITEM_LOCALES) {
    for (const query of stringColumnValues(generatedCatalogSearchArtifact.searchKeys[locale])) {
      if (maximum === undefined || Array.from(query).length > Array.from(maximum.query).length) {
        maximum = { locale, query };
      }
    }
  }
  assert.ok(maximum);
  return maximum;
}

function duplicateSearchKey(): SearchQuery {
  for (const locale of PEARL_ABYSS_ITEM_LOCALES) {
    const observed = new Set<string>();
    for (const query of stringColumnValues(generatedCatalogSearchArtifact.searchKeys[locale])) {
      if (Array.from(query).length >= 3 && observed.has(query)) return { locale, query };
      observed.add(query);
    }
  }
  throw new TypeError("The catalog contains no duplicate folded Item Names");
}

function searchKey(locale: PearlAbyssItemLocale, position: number): string {
  const key = generatedCatalogSearchArtifact.searchKeys[locale].valueAt(position);
  if (key === undefined) throw new RangeError(`Missing ${locale} search key at position ${position}`);
  return key;
}

function stringColumnValues(column: {
  readonly length: number;
  valueAt(position: number): string | undefined;
}): string[] {
  return Array.from({ length: column.length }, (_, position) => {
    const value = column.valueAt(position);
    if (value === undefined) throw new RangeError(`Missing packed string at position ${position}`);
    return value;
  });
}
