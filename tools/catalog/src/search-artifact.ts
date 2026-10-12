import { Buffer } from "node:buffer";

import {
  createImmutableNumberColumn,
  createPackedStringColumn,
  type CompactGramIndex,
  type GeneratedCatalogSearchArtifact,
  type ImmutableNumberColumn,
  type PackedStringColumn,
} from "@agris/catalog-subgraph/catalog-search-artifact";
import { foldCatalogItemName } from "@agris/catalog-subgraph/item-name-search";

import { CATALOG_ITEM_LOCALES, type CatalogArtifact, type CatalogItemLocale } from "./catalog.js";

const ARTIFACT_VERSION = 1;
const NORMALIZATION_VERSION = 1;
const UINT8_MAXIMUM = 0xff;
const UINT32_MAXIMUM = 0xffff_ffff;
const GENERATED_STRING_CHUNK_CODE_UNITS = 8_192;

export function createCatalogSearchArtifact(sources: readonly CatalogArtifact[]): GeneratedCatalogSearchArtifact {
  validateSourceCatalogs(sources);
  const source = sourceAccessor(sources);
  const english = source("EN");
  const itemIds = createImmutableNumberColumn(Uint32Array.from(english.items.map(({ itemId }) => itemId)));
  const grades = createImmutableNumberColumn(Uint8Array.from(english.items.map(({ grade }) => grade)));
  const displayNameValues = {
    EN: names(source("EN")),
    DE: names(source("DE")),
    FR: names(source("FR")),
    ES_EU: names(source("ES_EU")),
    ES: names(source("ES")),
    JA: names(source("JA")),
    KO: names(source("KO")),
    PT: names(source("PT")),
    RU: names(source("RU")),
    TH: names(source("TH")),
    TR: names(source("TR")),
    ZH_TW: names(source("ZH_TW")),
  } as const;
  const searchKeyValues = {
    EN: foldedNames(displayNameValues.EN, "EN"),
    DE: foldedNames(displayNameValues.DE, "DE"),
    FR: foldedNames(displayNameValues.FR, "FR"),
    ES_EU: foldedNames(displayNameValues.ES_EU, "ES_EU"),
    ES: foldedNames(displayNameValues.ES, "ES"),
    JA: foldedNames(displayNameValues.JA, "JA"),
    KO: foldedNames(displayNameValues.KO, "KO"),
    PT: foldedNames(displayNameValues.PT, "PT"),
    RU: foldedNames(displayNameValues.RU, "RU"),
    TH: foldedNames(displayNameValues.TH, "TH"),
    TR: foldedNames(displayNameValues.TR, "TR"),
    ZH_TW: foldedNames(displayNameValues.ZH_TW, "ZH_TW"),
  } as const;
  const displayNames = mapLocaleStringColumns(displayNameValues);
  const searchKeys = mapLocaleStringColumns(searchKeyValues);
  const artifact: GeneratedCatalogSearchArtifact = {
    version: ARTIFACT_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    maxFoldedItemNameCodePoints: maximumCodePointLength(searchKeys),
    sourceCatalogChecksums: {
      EN: source("EN").manifest.checksum,
      DE: source("DE").manifest.checksum,
      FR: source("FR").manifest.checksum,
      ES_EU: source("ES_EU").manifest.checksum,
      ES: source("ES").manifest.checksum,
      JA: source("JA").manifest.checksum,
      KO: source("KO").manifest.checksum,
      PT: source("PT").manifest.checksum,
      RU: source("RU").manifest.checksum,
      TH: source("TH").manifest.checksum,
      TR: source("TR").manifest.checksum,
      ZH_TW: source("ZH_TW").manifest.checksum,
    },
    itemIds,
    grades,
    displayNames,
    searchKeys,
    indexes: {
      EN: createCompactGramIndex(searchKeyValues.EN),
      DE: createCompactGramIndex(searchKeyValues.DE),
      FR: createCompactGramIndex(searchKeyValues.FR),
      ES_EU: createCompactGramIndex(searchKeyValues.ES_EU),
      ES: createCompactGramIndex(searchKeyValues.ES),
      JA: createCompactGramIndex(searchKeyValues.JA),
      KO: createCompactGramIndex(searchKeyValues.KO),
      PT: createCompactGramIndex(searchKeyValues.PT),
      RU: createCompactGramIndex(searchKeyValues.RU),
      TH: createCompactGramIndex(searchKeyValues.TH),
      TR: createCompactGramIndex(searchKeyValues.TR),
      ZH_TW: createCompactGramIndex(searchKeyValues.ZH_TW),
    },
  };
  validateCatalogSearchArtifact(artifact, sources);
  return artifact;
}

export function validateCatalogSearchArtifact(
  artifact: GeneratedCatalogSearchArtifact,
  sources: readonly CatalogArtifact[],
): void {
  validateSourceCatalogs(sources);
  if (artifact.version !== ARTIFACT_VERSION) throw new TypeError("Catalog search artifact version is invalid");
  if (artifact.normalizationVersion !== NORMALIZATION_VERSION) {
    throw new TypeError("Catalog search normalization version is invalid");
  }
  validateLocaleRecordKeys(artifact.sourceCatalogChecksums, "source checksums");
  validateLocaleRecordKeys(artifact.displayNames, "display-name columns");
  validateLocaleRecordKeys(artifact.searchKeys, "search-key columns");
  validateLocaleRecordKeys(artifact.indexes, "indexes");
  const source = sourceAccessor(sources);
  const english = source("EN");
  if (artifact.itemIds.length !== english.items.length || artifact.grades.length !== english.items.length) {
    throw new TypeError("Catalog search identity columns have invalid lengths");
  }
  for (const [position, reference] of english.items.entries()) {
    if (
      artifact.itemIds.valueAt(position) !== reference.itemId ||
      artifact.grades.valueAt(position) !== reference.grade
    ) {
      throw new TypeError(`Catalog search identity is misaligned at position ${position}`);
    }
  }

  let observedMaximum = 0;
  for (const definition of CATALOG_ITEM_LOCALES) {
    const { locale } = definition;
    const localeSource = source(locale);
    const displayNames = artifact.displayNames[locale];
    const searchKeys = artifact.searchKeys[locale];
    if (artifact.sourceCatalogChecksums[locale] !== localeSource.manifest.checksum) {
      throw new TypeError(`Catalog search ${locale} source checksum does not match`);
    }
    if (displayNames.length !== artifact.itemIds.length || searchKeys.length !== artifact.itemIds.length) {
      throw new TypeError(`Catalog search ${locale} columns have invalid lengths`);
    }
    for (const [position, sourceItem] of localeSource.items.entries()) {
      if (displayNames.valueAt(position) !== sourceItem.name) {
        throw new TypeError(`Catalog search ${locale} display name is misaligned at position ${position}`);
      }
      const expectedKey = foldCatalogItemName(sourceItem.name, locale);
      if (searchKeys.valueAt(position) !== expectedKey) {
        throw new TypeError(`Catalog search ${locale} key is misaligned at position ${position}`);
      }
      observedMaximum = Math.max(observedMaximum, codePointLength(expectedKey));
    }
    validateCompactGramIndex(artifact.indexes[locale], searchKeys, locale);
  }
  if (artifact.maxFoldedItemNameCodePoints !== observedMaximum) {
    throw new TypeError("Catalog search maximum folded Item Name length does not match");
  }
}

export function serializeCatalogSearchArtifactModule(artifact: GeneratedCatalogSearchArtifact): string {
  const serializedLocales = CATALOG_ITEM_LOCALES.map(({ locale }) => locale);
  const lines = [
    "// Generated by catalog-tools:generate. Do not edit.",
    'import { createImmutableNumberColumn, createPackedStringColumn, type GeneratedCatalogSearchArtifact, type ImmutableNumberColumn } from "./catalog-search-artifact.js";',
    "",
    'const packed = (chunks: readonly string[]): string => chunks.join("");',
    "const rawU32 = (length: number, encoded: string): Uint32Array => {",
    "  const bytes = atob(encoded);",
    "  const values = new Uint32Array(length);",
    "  let byteIndex = 0;",
    "  for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {",
    "    let value = 0;",
    "    let shift = 0;",
    "    let byte = 0;",
    "    do {",
    "      byte = bytes.charCodeAt(byteIndex);",
    '      if (Number.isNaN(byte) || shift > 28) throw new TypeError("Invalid generated Uint32Array payload");',
    "      byteIndex += 1;",
    "      value = (value | ((byte & 127) << shift)) >>> 0;",
    "      shift += 7;",
    "    } while ((byte & 128) !== 0);",
    "    values[valueIndex] = value;",
    "  }",
    '  if (byteIndex !== bytes.length) throw new TypeError("Invalid generated Uint32Array payload length");',
    "  return values;",
    "};",
    "const u32 = (length: number, encoded: string): ImmutableNumberColumn => createImmutableNumberColumn(rawU32(length, encoded));",
    "const u8 = (encoded: string): ImmutableNumberColumn => {",
    "  const bytes = atob(encoded);",
    "  const values = new Uint8Array(bytes.length);",
    "  for (let index = 0; index < values.length; index += 1) values[index] = bytes.charCodeAt(index);",
    "  return createImmutableNumberColumn(values);",
    "};",
    "",
    "export const generatedCatalogSearchArtifact: GeneratedCatalogSearchArtifact = Object.freeze({",
    `  version: ${artifact.version},`,
    `  normalizationVersion: ${artifact.normalizationVersion},`,
    `  maxFoldedItemNameCodePoints: ${artifact.maxFoldedItemNameCodePoints},`,
    `  sourceCatalogChecksums: Object.freeze(${JSON.stringify(artifact.sourceCatalogChecksums)}),`,
    `  itemIds: u32(${artifact.itemIds.length}, ${serializePackedString(encodeUint32Column(artifact.itemIds))}),`,
    `  grades: u8(${serializePackedString(encodeUint8Column(artifact.grades))}),`,
    "  displayNames: Object.freeze({",
    ...serializedLocales.map((locale) => `    ${locale}: ${serializeStringColumn(artifact.displayNames[locale])},`),
    "  }),",
    "  searchKeys: Object.freeze({",
    ...serializedLocales.map((locale) => `    ${locale}: ${serializeStringColumn(artifact.searchKeys[locale])},`),
    "  }),",
    "  indexes: Object.freeze({",
    ...serializedLocales.map((locale) => {
      const index = artifact.indexes[locale];
      return `    ${locale}: Object.freeze({ grams: ${serializeStringColumn(index.grams)}, offsets: u32(${index.offsets.length}, ${serializePackedString(encodeUint32Column(index.offsets))}), postings: u32(${index.postings.length}, ${serializePackedString(encodeUint32Column(index.postings))}) }),`;
    }),
    "  }),",
    "});",
    "",
  ];
  return lines.join("\n");
}

function encodeUint32Column(values: ImmutableNumberColumn): string {
  const bytes: number[] = [];
  for (let position = 0; position < values.length; position += 1) {
    const value = values.valueAt(position);
    if (value === undefined) throw new TypeError(`Immutable number column is missing position ${position}`);
    let remaining = value;
    do {
      const byte = remaining & 0x7f;
      remaining >>>= 7;
      bytes.push(remaining === 0 ? byte : byte | 0x80);
    } while (remaining !== 0);
  }
  return Buffer.from(bytes).toString("base64");
}

function encodeUint32Array(values: Uint32Array): string {
  return encodeUint32Column(createImmutableNumberColumn(values));
}

function encodeUint8Column(values: ImmutableNumberColumn): string {
  return Buffer.from(numberColumnValues(values)).toString("base64");
}

function serializeStringColumn(column: PackedStringColumn): string {
  const values: string[] = [];
  const offsets = new Uint32Array(column.length + 1);
  let packedLength = 0;
  for (let position = 0; position < column.length; position += 1) {
    const value = column.valueAt(position);
    if (value === undefined) throw new TypeError(`Packed string column is missing position ${position}`);
    values.push(value);
    packedLength += value.length;
    offsets[position + 1] = packedLength;
  }
  return `createPackedStringColumn(${serializePackedString(values.join(""))}, rawU32(${offsets.length}, ${serializePackedString(encodeUint32Array(offsets))}))`;
}

function serializePackedString(value: string): string {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += GENERATED_STRING_CHUNK_CODE_UNITS) {
    chunks.push(value.slice(index, index + GENERATED_STRING_CHUNK_CODE_UNITS));
  }
  return `packed([\n${chunks.map((chunk) => JSON.stringify(chunk)).join(",\n")}\n])`;
}

function validateSourceCatalogs(sources: readonly CatalogArtifact[]): void {
  const expectedLocales = CATALOG_ITEM_LOCALES.map(({ locale }) => locale);
  if (sources.length !== expectedLocales.length) throw new TypeError("Catalog search generation requires all locales");
  if (sources.map(({ manifest }) => manifest.locale).join(",") !== expectedLocales.join(",")) {
    throw new TypeError("Catalog search sources must use canonical locale order");
  }
  const english = sources[0];
  if (english === undefined || english.manifest.locale !== "EN") throw new TypeError("English must be the reference");
  if (english.items.length !== english.manifest.itemCount) throw new TypeError("English item count does not match");
  let previousItemId = 0;
  for (const [position, item] of english.items.entries()) {
    if (item.itemId <= previousItemId || item.itemId > UINT32_MAXIMUM) {
      throw new TypeError(`English Item ID is invalid at position ${position}`);
    }
    if (item.grade < 0 || item.grade > UINT8_MAXIMUM || !Number.isSafeInteger(item.grade)) {
      throw new TypeError(`English Item grade is invalid at position ${position}`);
    }
    previousItemId = item.itemId;
  }
  for (const source of sources) {
    if (source.items.length !== source.manifest.itemCount || source.items.length !== english.items.length) {
      throw new TypeError(`Catalog source ${source.manifest.locale} item count does not match`);
    }
    for (const [position, item] of source.items.entries()) {
      const reference = english.items[position];
      if (
        reference === undefined ||
        item.itemId !== reference.itemId ||
        item.grade !== reference.grade ||
        item.locale !== source.manifest.locale ||
        item.nameLocale !== source.manifest.locale
      ) {
        throw new TypeError(`Catalog source ${source.manifest.locale} is misaligned at position ${position}`);
      }
    }
  }
}

function validateLocaleRecordKeys<Value>(value: Readonly<Record<CatalogItemLocale, Value>>, label: string): void {
  const expected = CATALOG_ITEM_LOCALES.map(({ locale }) => locale).sort();
  const observed = Object.keys(value).sort();
  if (!equalStrings(observed, expected)) throw new TypeError(`Catalog search ${label} do not contain all locales`);
}

function sourceAccessor(sources: readonly CatalogArtifact[]): (locale: CatalogItemLocale) => CatalogArtifact {
  const byLocale = new Map(sources.map((source) => [source.manifest.locale, source]));
  return (locale) => {
    const source = byLocale.get(locale);
    if (source === undefined) throw new TypeError(`Catalog source ${locale} is missing`);
    return source;
  };
}

function names(source: CatalogArtifact): readonly string[] {
  return source.items.map(({ name }) => name);
}

function foldedNames(displayNames: readonly string[], locale: CatalogItemLocale): readonly string[] {
  return displayNames.map((name) => foldCatalogItemName(name, locale));
}

function maximumCodePointLength(searchKeys: GeneratedCatalogSearchArtifact["searchKeys"]): number {
  let maximum = 0;
  for (const definition of CATALOG_ITEM_LOCALES) {
    const column = searchKeys[definition.locale];
    for (let position = 0; position < column.length; position += 1) {
      const key = column.valueAt(position);
      if (key === undefined) throw new TypeError(`Catalog search ${definition.locale} key is missing`);
      maximum = Math.max(maximum, codePointLength(key));
    }
  }
  return maximum;
}

function mapLocaleStringColumns(values: Readonly<Record<CatalogItemLocale, readonly string[]>>) {
  return {
    EN: packStringColumn(values.EN),
    DE: packStringColumn(values.DE),
    FR: packStringColumn(values.FR),
    ES_EU: packStringColumn(values.ES_EU),
    ES: packStringColumn(values.ES),
    JA: packStringColumn(values.JA),
    KO: packStringColumn(values.KO),
    PT: packStringColumn(values.PT),
    RU: packStringColumn(values.RU),
    TH: packStringColumn(values.TH),
    TR: packStringColumn(values.TR),
    ZH_TW: packStringColumn(values.ZH_TW),
  } satisfies GeneratedCatalogSearchArtifact["displayNames"];
}

function packStringColumn(values: readonly string[]): PackedStringColumn {
  const offsets = new Uint32Array(values.length + 1);
  let packedLength = 0;
  for (const [position, value] of values.entries()) {
    packedLength += value.length;
    offsets[position + 1] = packedLength;
  }
  return createPackedStringColumn(values.join(""), offsets);
}

function numberColumnValues(column: ImmutableNumberColumn): number[] {
  return Array.from({ length: column.length }, (_, position) => {
    const value = column.valueAt(position);
    if (value === undefined) throw new TypeError(`Immutable number column is missing position ${position}`);
    return value;
  });
}

function createCompactGramIndex(searchKeys: readonly string[]): CompactGramIndex {
  const postingsByGram = new Map<string, number[]>();
  for (const [position, searchKey] of searchKeys.entries()) {
    for (const gram of distinctTrigrams(searchKey)) {
      const postings = postingsByGram.get(gram);
      if (postings === undefined) postingsByGram.set(gram, [position]);
      else postings.push(position);
    }
  }
  const grams = [...postingsByGram.keys()].sort();
  const offsets = new Uint32Array(grams.length + 1);
  let postingCount = 0;
  for (const [gramIndex, gram] of grams.entries()) {
    offsets[gramIndex] = postingCount;
    postingCount += postingsByGram.get(gram)?.length ?? 0;
  }
  offsets[grams.length] = postingCount;
  const postings = new Uint32Array(postingCount);
  let cursor = 0;
  for (const gram of grams) {
    for (const position of postingsByGram.get(gram) ?? []) {
      postings[cursor] = position;
      cursor += 1;
    }
  }
  return {
    grams: packStringColumn(grams),
    offsets: createImmutableNumberColumn(offsets),
    postings: createImmutableNumberColumn(postings),
  };
}

function validateCompactGramIndex(
  index: CompactGramIndex,
  searchKeys: PackedStringColumn,
  locale: CatalogItemLocale,
): void {
  if (index.offsets.length !== index.grams.length + 1) {
    throw new TypeError(`Catalog search ${locale} offset count is invalid`);
  }
  if (index.offsets.valueAt(0) !== 0 || index.offsets.valueAt(index.offsets.length - 1) !== index.postings.length) {
    throw new TypeError(`Catalog search ${locale} offsets do not span postings`);
  }
  const expected = createCompactGramIndex(stringColumnValues(searchKeys));
  if (!equalStringColumns(index.grams, expected.grams)) {
    throw new TypeError(`Catalog search ${locale} grams are not unique, sorted, and complete`);
  }
  if (!equalNumbers(index.offsets, expected.offsets)) {
    throw new TypeError(`Catalog search ${locale} offsets are not monotonic and aligned`);
  }
  if (!equalNumbers(index.postings, expected.postings)) {
    throw new TypeError(`Catalog search ${locale} postings are not unique, increasing, and aligned`);
  }
  for (const position of numberColumnValues(index.postings)) {
    if (position >= searchKeys.length) throw new TypeError(`Catalog search ${locale} posting is out of bounds`);
  }
}

function stringColumnValues(column: PackedStringColumn): readonly string[] {
  const values: string[] = [];
  for (let position = 0; position < column.length; position += 1) {
    const value = column.valueAt(position);
    if (value === undefined) throw new TypeError(`Packed string column is missing position ${position}`);
    values.push(value);
  }
  return values;
}

function distinctTrigrams(value: string): ReadonlySet<string> {
  const characters = Array.from(value);
  const grams = new Set<string>();
  for (let index = 0; index + 2 < characters.length; index += 1) {
    grams.add(`${characters[index]}${characters[index + 1]}${characters[index + 2]}`);
  }
  return grams;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function equalStringColumns(left: PackedStringColumn, right: PackedStringColumn): boolean {
  if (left.length !== right.length) return false;
  for (let position = 0; position < left.length; position += 1) {
    if (left.valueAt(position) !== right.valueAt(position)) return false;
  }
  return true;
}

function equalNumbers(left: ImmutableNumberColumn, right: ImmutableNumberColumn): boolean {
  if (left.length !== right.length) return false;
  for (let position = 0; position < left.length; position += 1) {
    if (left.valueAt(position) !== right.valueAt(position)) return false;
  }
  return true;
}
