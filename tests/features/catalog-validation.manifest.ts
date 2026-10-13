import assert from "node:assert/strict";

import {
  CATALOG_ITEM_LOCALES,
  type CatalogArtifact,
  type CatalogArtifactItem,
  type CatalogItemLocale,
} from "../../tools/catalog/src/catalog.ts";
import { CatalogValidationError, validateCatalog } from "../../tools/catalog/src/catalog-validation.ts";
import {
  dataTableStepArgument,
  noStepArguments,
  step,
  type ExecutableFeatureManifest,
  type StepDefinition,
} from "../support/manifest.ts";

interface CatalogValidationWorld {
  outcomes?: readonly { readonly caseName: string; readonly expected: string; readonly actual: string }[];
}

const ENGLISH = [
  { itemId: 16001, name: "Black Stone (Weapon)", grade: 1 },
  { itemId: 44195, name: "Memory Fragment", grade: 2 },
] as const;

interface CatalogCase {
  readonly catalog: readonly CatalogArtifact[];
  readonly sameAsEnglish: readonly string[];
}

/** Every locale names each English item `<English name> [<locale>]`, unless a case says otherwise. */
function catalog(
  rename: (locale: CatalogItemLocale, item: (typeof ENGLISH)[number]) => Partial<CatalogArtifactItem> = () => ({}),
  english: readonly (typeof ENGLISH)[number][] = ENGLISH,
): readonly CatalogArtifact[] {
  return CATALOG_ITEM_LOCALES.map(({ locale }) => {
    const items = english.map((item) => ({
      itemId: item.itemId,
      locale,
      name: locale === "EN" ? item.name : `${item.name} [${locale}]`,
      nameLocale: locale,
      grade: item.grade,
      ...(locale === "EN" ? {} : rename(locale, item)),
    }));
    return { items, serializedItems: "", manifest: { locale, checksum: "", itemCount: items.length } };
  });
}

const sameNameInGerman = catalog((locale, item) =>
  locale === "DE" && item.itemId === 44195 ? { name: item.name } : {},
);

const CASES: Readonly<Record<string, CatalogCase>> = {
  "a well-formed catalog": { catalog: catalog(), sameAsEnglish: [] },
  "a German name equal to English that is listed": { catalog: sameNameInGerman, sameAsEnglish: ["DE:44195"] },
  "a German name equal to English that is not listed": { catalog: sameNameInGerman, sameAsEnglish: [] },
  "a listed German name that differs from English": { catalog: catalog(), sameAsEnglish: ["DE:44195"] },
  "a French name in Korean script": {
    catalog: catalog((locale) => (locale === "FR" ? { name: "기억의 파편" } : {})),
    sameAsEnglish: [],
  },
  "German grades that differ from English": {
    catalog: catalog((locale, item) => (locale === "DE" ? { grade: item.grade + 1 } : {})),
    sameAsEnglish: [],
  },
  "English items out of ID order": { catalog: catalog(undefined, [...ENGLISH].reverse()), sameAsEnglish: [] },
};

const steps: readonly StepDefinition<CatalogValidationWorld>[] = [
  step("these catalogs are validated", dataTableStepArgument, (world, table) => {
    world.outcomes = table.hashes.map((row) => {
      const caseName = row.case;
      const expected = row.outcome;
      assert.ok(caseName);
      assert.ok(expected);
      const catalogCase = CASES[caseName];
      assert.ok(catalogCase, `Unknown catalog case: ${caseName}`);
      return { caseName, expected, actual: validationRule(catalogCase) };
    });
  }),
  step("every catalog meets its specified outcome", noStepArguments, (world) => {
    assert.ok(world.outcomes);
    for (const { caseName, expected, actual } of world.outcomes) assert.equal(actual, expected, caseName);
  }),
];

export const catalogValidationFeature: ExecutableFeatureManifest<CatalogValidationWorld> = {
  id: "catalog-validation",
  uri: "tests/features/catalog-validation.feature",
  createWorld: () => ({}),
  steps,
};

function validationRule({ catalog: artifacts, sameAsEnglish }: CatalogCase): string {
  try {
    validateCatalog(artifacts, sameAsEnglish);
    return "valid";
  } catch (error: unknown) {
    if (error instanceof CatalogValidationError) return error.rule;
    throw error;
  }
}
