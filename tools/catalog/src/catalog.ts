import { PEARL_ABYSS_ITEM_LOCALE_DESCRIPTORS, type PearlAbyssItemLocale } from "@agris/pearl-abyss/locales";

/** The catalog ships one item list per locale at `data/<locale>/items.json`, every list naming the same items. */
export const CATALOG_ITEM_LOCALES = PEARL_ABYSS_ITEM_LOCALE_DESCRIPTORS;

export type CatalogItemLocale = PearlAbyssItemLocale;

export interface CatalogArtifactItem {
  readonly itemId: number;
  readonly locale: CatalogItemLocale;
  readonly name: string;
  readonly nameLocale: CatalogItemLocale;
  readonly grade: number;
}

/** What one locale's list is, computed when it is read: nothing about it is stored beside the items. */
export interface CatalogArtifactManifest {
  readonly locale: CatalogItemLocale;
  /** SHA-256 of the locale's `items.json` text, which the search artifact records per locale. */
  readonly checksum: string;
  readonly itemCount: number;
}

export interface CatalogArtifact {
  readonly items: readonly CatalogArtifactItem[];
  readonly manifest: CatalogArtifactManifest;
  readonly serializedItems: string;
}
