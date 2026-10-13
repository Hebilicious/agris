import type { PearlAbyssItemLocale } from "@agris/pearl-abyss/locales";

import { generatedCatalogSearchArtifact } from "./generated-catalog-search-artifact.js";

export interface CatalogItem {
  readonly itemId: number;
  readonly locale: PearlAbyssItemLocale;
  readonly name: string;
  readonly grade: number;
}

export interface CatalogArtifactMetadata {
  readonly version: 1;
  readonly normalizationVersion: 1;
  readonly itemCount: number;
  readonly sourceCatalogChecksums: Readonly<Record<PearlAbyssItemLocale, string>>;
}

const sourceCatalogChecksums = Object.freeze({ ...generatedCatalogSearchArtifact.sourceCatalogChecksums });

/** Immutable build-time identity for the catalog records bundled into this deployment. */
export const catalogArtifactMetadata: CatalogArtifactMetadata = Object.freeze({
  version: generatedCatalogSearchArtifact.version,
  normalizationVersion: generatedCatalogSearchArtifact.normalizationVersion,
  itemCount: generatedCatalogSearchArtifact.itemIds.length,
  sourceCatalogChecksums,
});

/** Returns a detached locale projection, or null when the item ID is absent from this catalog deployment. */
export function catalogItem(locale: PearlAbyssItemLocale, itemId: number): CatalogItem | null {
  const position = catalogItemPosition(itemId);
  return position === null ? null : catalogItemAt(locale, position);
}

/** Returns a detached locale projection for an artifact position. */
export function catalogItemAt(locale: PearlAbyssItemLocale, position: number): CatalogItem {
  const itemId = generatedCatalogSearchArtifact.itemIds.valueAt(position);
  const grade = generatedCatalogSearchArtifact.grades.valueAt(position);
  const name = generatedCatalogSearchArtifact.displayNames[locale].valueAt(position);
  if (itemId === undefined || grade === undefined || name === undefined) {
    throw new RangeError(`Catalog item position ${position} is outside the bundled artifact`);
  }
  return { itemId, locale, name, grade };
}

export function catalogItemPosition(itemId: number): number | null {
  let low = 0;
  let high = generatedCatalogSearchArtifact.itemIds.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = generatedCatalogSearchArtifact.itemIds.valueAt(middle);
    if (candidate === undefined) return null;
    if (candidate < itemId) low = middle + 1;
    else if (candidate > itemId) high = middle - 1;
    else return middle;
  }
  return null;
}
