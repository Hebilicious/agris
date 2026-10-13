import { CATALOG_ITEM_LOCALES, type CatalogArtifact, type CatalogItemLocale } from "./catalog.js";

/** The rule a catalog breaks; `catalog-tools:validate` prints the message, evidence matches the rule. */
export type CatalogRule =
  | "locale-order"
  | "item-order"
  | "native-name"
  | "wrong-script"
  | "english-reference"
  | "unlisted-same-as-english"
  | "unused-same-as-english"
  | "same-as-english-key";

export class CatalogValidationError extends Error {
  public constructor(
    public readonly rule: CatalogRule,
    message: string,
  ) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

/**
 * Check the shipped catalog: one list per locale in `CATALOG_ITEM_LOCALES` order, English first; every list holds the
 * same item IDs and grades as English in strictly increasing ID order; every name is native to its locale and in its
 * script; and a localized name equals the English one only when `sameAsEnglish` lists it, with no listed key unused.
 */
export function validateCatalog(artifacts: readonly CatalogArtifact[], sameAsEnglish: unknown): void {
  const listed = decodeSameAsEnglish(sameAsEnglish);
  const unused = new Set(listed);
  const expectedLocales = CATALOG_ITEM_LOCALES.map(({ locale }) => locale);
  if (artifacts.map(({ manifest }) => manifest.locale).join(",") !== expectedLocales.join(",")) {
    throw new CatalogValidationError("locale-order", `The catalog must list ${expectedLocales.join(", ")} in order`);
  }

  const english = artifacts[0];
  if (english === undefined) throw new CatalogValidationError("locale-order", "The catalog has no English list");
  for (const artifact of artifacts) {
    const locale = artifact.manifest.locale;
    let previousItemId = 0;
    for (const [index, item] of artifact.items.entries()) {
      if (item.itemId <= previousItemId) {
        throw new CatalogValidationError("item-order", `${locale} item ${item.itemId} is not in increasing ID order`);
      }
      previousItemId = item.itemId;
      if (item.locale !== locale || item.nameLocale !== locale) {
        throw new CatalogValidationError("native-name", `${locale} item ${item.itemId} does not have a ${locale} name`);
      }
      if (locale !== "KO" && containsHangul(item.name)) {
        throw new CatalogValidationError("wrong-script", `${locale} item ${item.itemId} has a Korean name`);
      }
      if (locale === "EN") continue;
      const reference = english.items[index];
      if (reference === undefined || reference.itemId !== item.itemId || reference.grade !== item.grade) {
        throw new CatalogValidationError(
          "english-reference",
          `${locale} IDs or grades differ from English at ${index}`,
        );
      }
      const key = `${locale}:${item.itemId}`;
      if (item.name === reference.name) {
        if (!listed.has(key)) {
          throw new CatalogValidationError(
            "unlisted-same-as-english",
            `${locale} item ${item.itemId} equals its English name but same-as-english.json does not list it`,
          );
        }
        unused.delete(key);
      }
    }
    if (locale !== "EN" && artifact.items.length !== english.items.length) {
      throw new CatalogValidationError("english-reference", `${locale} item count differs from English`);
    }
  }
  const [stale] = unused;
  if (stale !== undefined) {
    throw new CatalogValidationError(
      "unused-same-as-english",
      `same-as-english.json lists ${stale}, whose name differs from English or which does not exist`,
    );
  }
}

/* BOUNDARY: data/catalog/same-as-english.json, a list of unique `LOCALE:itemId` keys for non-English locales. */
function decodeSameAsEnglish(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value))
    throw new CatalogValidationError("same-as-english-key", "same-as-english.json must be a list");
  const keys = new Set<string>();
  for (const key of value) {
    const [locale, itemId] = typeof key === "string" ? key.split(":") : [];
    if (locale === undefined || locale === "EN" || !isCatalogLocale(locale) || !/^[1-9]\d*$/u.test(itemId ?? "")) {
      throw new CatalogValidationError(
        "same-as-english-key",
        `same-as-english.json has an invalid key: ${String(key)}`,
      );
    }
    if (keys.has(key)) throw new CatalogValidationError("same-as-english-key", `same-as-english.json repeats ${key}`);
    keys.add(key);
  }
  return keys;
}

export function isCatalogLocale(value: unknown): value is CatalogItemLocale {
  return typeof value === "string" && CATALOG_ITEM_LOCALES.some((definition) => definition.locale === value);
}

function containsHangul(value: string): boolean {
  return /[가-힣]/u.test(value);
}
