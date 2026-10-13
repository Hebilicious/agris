import assert from "node:assert/strict";

import {
  PEARL_ABYSS_ITEM_LOCALES,
  type PearlAbyssItemLocale,
} from "../../packages/pearl-abyss/src/protocol/locale-descriptor.ts";
import { generatedCatalogSearchArtifact } from "../../packages/catalog-subgraph/dist/generated-catalog-search-artifact.js";
import { catalogItemNameSearch, foldCatalogItemName } from "../../packages/catalog-subgraph/dist/item-name-search.js";
import {
  dataTableStepArgument,
  step,
  stringStepArgument,
  type DataTable,
  type ExecutableFeatureManifest,
  type StepDefinition,
} from "../support/manifest.ts";

type ItemNameSearchWorld = Record<string, never>;

const steps: readonly StepDefinition<ItemNameSearchWorld>[] = [
  step(
    "these locale-scoped queries return at least one exact substring match",
    dataTableStepArgument,
    (_world, table) => {
      for (const { locale: rawLocale, query } of requiredSearchExamples(table)) {
        const locale = itemLocale(rawLocale);
        const result = catalogItemNameSearch.search({ locale, query, first: 100 });
        assert.equal(result.ok, true, `${locale} ${query} should be accepted`);
        if (!result.ok) continue;
        assert.ok(result.totalCount > 0, `${locale} ${query} should match at least one Item Name`);
        const foldedQuery = foldCatalogItemName(query, locale);
        for (const position of result.itemPositions) {
          assert.ok(generatedCatalogSearchArtifact.searchKeys[locale].valueAt(position)?.includes(foldedQuery));
        }
      }
    },
  ),
  step("the English query {string} returns no Chiro Item Name", stringStepArgument, (_world, query) => {
    const result = catalogItemNameSearch.search({ locale: "EN", query, first: 100 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const names = generatedCatalogSearchArtifact.displayNames.EN;
    const chiroPositions = Array.from({ length: names.length }, (_, position) => ({
      name: names.valueAt(position),
      position,
    }))
      .filter(({ name }) => name?.includes("Chiro") === true)
      .map(({ position }) => position);
    assert.ok(chiroPositions.length > 0);
    assert.ok(result.itemPositions.every((position) => !chiroPositions.includes(position)));
  }),
];

function requiredSearchExamples(table: DataTable): readonly Readonly<Record<"locale" | "query", string>>[] {
  assert.deepEqual(table.raw[0], ["locale", "query"]);
  return table.hashes.map((row) => {
    assert.deepEqual(Object.keys(row), ["locale", "query"]);
    const locale = row.locale;
    const query = row.query;
    assert.ok(locale !== undefined && query !== undefined);
    return { locale, query };
  });
}

function itemLocale(value: string): PearlAbyssItemLocale {
  const locale = PEARL_ABYSS_ITEM_LOCALES.find((candidate) => candidate === value);
  if (locale === undefined) throw new TypeError(`Unknown Item Locale ${value}`);
  return locale;
}

export const itemNameSearchFeature: ExecutableFeatureManifest<ItemNameSearchWorld> = {
  id: "item-name-search",
  uri: "tests/features/item-name-search.feature",
  createWorld: () => ({}),
  steps,
};
