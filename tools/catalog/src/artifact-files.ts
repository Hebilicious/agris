import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  CATALOG_ITEM_LOCALES,
  type CatalogArtifact,
  type CatalogArtifactItem,
  type CatalogItemLocale,
} from "./catalog.js";
import { isCatalogLocale } from "./catalog-validation.js";

/** Read every locale's `items.json`, in `CATALOG_ITEM_LOCALES` order, with its checksum and count computed. */
export async function readCatalogArtifacts(
  dataDirectory = new URL("../../../data/catalog/", import.meta.url),
): Promise<readonly CatalogArtifact[]> {
  const artifacts: CatalogArtifact[] = [];
  for (const definition of CATALOG_ITEM_LOCALES) {
    const serializedItems = await readFile(
      new URL(`${definition.locale.toLowerCase()}/items.json`, dataDirectory),
      "utf8",
    );
    const items = decodeItems(JSON.parse(serializedItems), definition.locale);
    const checksum = createHash("sha256").update(serializedItems).digest("hex");
    artifacts.push({
      items,
      serializedItems,
      manifest: { locale: definition.locale, checksum, itemCount: items.length },
    });
  }
  return artifacts;
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function decodeItems(
  value: unknown,
  locale: CatalogItemLocale,
): readonly CatalogArtifactItem[] {
  if (!Array.isArray(value)) throw new TypeError(`${locale} catalog must contain an item array`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`${locale} catalog item ${index} must be an object`);
    if (typeof item.itemId !== "number" || !Number.isSafeInteger(item.itemId) || item.itemId <= 0) {
      throw new TypeError(`${locale} catalog item ${index} has an invalid ID`);
    }
    if (typeof item.name !== "string" || item.name.trim().length === 0) {
      throw new TypeError(`${locale} catalog item ${item.itemId} has no name`);
    }
    if (!isCatalogLocale(item.locale) || !isCatalogLocale(item.nameLocale)) {
      throw new TypeError(`${locale} catalog item ${item.itemId} has an invalid locale`);
    }
    if (typeof item.grade !== "number" || !Number.isSafeInteger(item.grade) || item.grade < 0) {
      throw new TypeError(`${locale} catalog item ${item.itemId} has an invalid grade`);
    }
    return {
      itemId: item.itemId,
      locale: item.locale,
      name: item.name,
      nameLocale: item.nameLocale,
      grade: item.grade,
    };
  });
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
