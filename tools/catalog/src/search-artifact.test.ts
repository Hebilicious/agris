import { expect, it } from "vitest";

import { readFile } from "node:fs/promises";

import { foldCatalogItemName } from "@agris/catalog-subgraph/item-name-search";
import { PEARL_ABYSS_ITEM_LOCALES } from "@agris/pearl-abyss/locales";
import { createImmutableNumberColumn, createPackedStringColumn } from "@agris/catalog-subgraph/catalog-search-artifact";
import { generatedCatalogSearchArtifact } from "@agris/catalog-subgraph/generated-catalog-search-artifact";

import { readCatalogArtifacts } from "./artifact-files.js";
import { catalogDataIdentity, readCatalogCode, serializeCatalogIdentityModule } from "./catalog-identity.js";
import {
  createCatalogSearchArtifact,
  serializeCatalogSearchArtifactModule,
  validateCatalogSearchArtifact,
} from "./search-artifact.js";

const generatedModuleUrl = new URL(
  "../../../packages/catalog-subgraph/src/generated-catalog-search-artifact.ts",
  import.meta.url,
);
const generatedIdentityUrl = new URL(
  "../../../packages/core/src/protocol/generated-catalog-identity.ts",
  import.meta.url,
);

it("implements the catalog's locale-aware Unicode folding contract", () => {
  expect(foldCatalogItemName("  Épée—Chiro's Black\u00a0Stone  ", "EN")).toBe("epeechirosblackstone");
  expect(foldCatalogItemName("Iİ ıi", "TR")).toBe("ıiıi");
  expect(foldCatalogItemName("ก้ า", "TH")).toBe("ก้า");
  expect(foldCatalogItemName("ガ + 1", "JA")).toBe("ガ+1");

  const sourceOffsets = new Uint32Array([0, 3, 4]);
  const column = createPackedStringColumn("one二", sourceOffsets);
  sourceOffsets[1] = 0;
  expect(Object.isFrozen(column)).toBe(true);
  expect([column.valueAt(0), column.valueAt(1)]).toEqual(["one", "二"]);
  expect([column.valueAt(-1), column.valueAt(2), column.valueAt(0.5)]).toEqual([undefined, undefined, undefined]);
  expect(() => createPackedStringColumn("one", new Uint32Array([0, 4]))).toThrow(/offset/i);

  const sourceNumbers = new Uint32Array([7, 11]);
  const numbers = createImmutableNumberColumn(sourceNumbers);
  sourceNumbers[0] = 99;
  expect(Object.isFrozen(numbers)).toBe(true);
  expect([numbers.valueAt(0), numbers.valueAt(1)]).toEqual([7, 11]);
  expect([numbers.valueAt(-1), numbers.valueAt(2), numbers.valueAt(0.5)]).toEqual([undefined, undefined, undefined]);
});

it("generates one deterministic, aligned, checksummed all-locale artifact", async () => {
  const sources = await readCatalogArtifacts();
  const first = createCatalogSearchArtifact(sources);
  const second = createCatalogSearchArtifact(sources);

  validateCatalogSearchArtifact(first, sources);
  validateCatalogSearchArtifact(generatedCatalogSearchArtifact, sources);
  expect(serializeCatalogSearchArtifactModule(second)).toBe(serializeCatalogSearchArtifactModule(first));
  expect(await readFile(generatedModuleUrl, "utf8")).toBe(serializeCatalogSearchArtifactModule(first));
  expect(await readFile(generatedIdentityUrl, "utf8")).toBe(
    serializeCatalogIdentityModule(catalogDataIdentity(sources, await readCatalogCode())),
  );

  expect(first.maxFoldedItemNameCodePoints).toBe(69);
  const globalMaximums = Object.entries(first.searchKeys).flatMap(([locale, keys]) =>
    Array.from({ length: keys.length }, (_, position) => ({ key: keys.valueAt(position), position })).flatMap(
      ({ key, position }) =>
        key !== undefined && Array.from(key).length === first.maxFoldedItemNameCodePoints
          ? [{ locale, itemId: first.itemIds.valueAt(position) }]
          : [],
    ),
  );
  expect(globalMaximums).toEqual([{ locale: "DE", itemId: 25_145 }]);
  expect(first.sourceCatalogChecksums).toEqual(
    Object.fromEntries(sources.map(({ manifest }) => [manifest.locale, manifest.checksum])),
  );
  expect(Object.isFrozen(generatedCatalogSearchArtifact)).toBe(true);
  expect(Object.isFrozen(generatedCatalogSearchArtifact.sourceCatalogChecksums)).toBe(true);
  expect(Object.isFrozen(generatedCatalogSearchArtifact.displayNames)).toBe(true);
  expect(Object.isFrozen(generatedCatalogSearchArtifact.searchKeys)).toBe(true);
  expect(Object.isFrozen(generatedCatalogSearchArtifact.indexes)).toBe(true);
  expect(
    PEARL_ABYSS_ITEM_LOCALES.every((locale) => Object.isFrozen(generatedCatalogSearchArtifact.indexes[locale])),
  ).toBe(true);
  expect(Reflect.set(generatedCatalogSearchArtifact.indexes, "EN", generatedCatalogSearchArtifact.indexes.DE)).toBe(
    false,
  );
});

it("rejects structurally invalid compact postings", async () => {
  const sources = await readCatalogArtifacts();
  const valid = createCatalogSearchArtifact(sources);
  const en = valid.indexes.EN;
  const invalidOffsets = Uint32Array.from(
    { length: en.offsets.length },
    (_, position) => en.offsets.valueAt(position) ?? 0,
  );
  invalidOffsets[invalidOffsets.length - 1] = en.postings.length + 1;
  const invalid = {
    ...valid,
    indexes: {
      ...valid.indexes,
      EN: { ...en, offsets: createImmutableNumberColumn(invalidOffsets) },
    },
  };

  expect(() => validateCatalogSearchArtifact(invalid, sources)).toThrow(/offset/i);
});
