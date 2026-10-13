import type { PearlAbyssItemLocale } from "@agris/pearl-abyss/locales";

import type { CompactGramIndex, GeneratedCatalogSearchArtifact } from "./catalog-search-artifact.js";
import { generatedCatalogSearchArtifact } from "./generated-catalog-search-artifact.js";

const MINIMUM_QUERY_LENGTH = 3;
const MINIMUM_FIRST = 1;
const MAXIMUM_FIRST = 100;

const BCP_47_TAGS = {
  EN: "en",
  DE: "de",
  FR: "fr",
  ES_EU: "es-ES",
  ES: "es-MX",
  JA: "ja",
  KO: "ko",
  PT: "pt-BR",
  RU: "ru",
  TH: "th",
  TR: "tr",
  ZH_TW: "zh-Hant-TW",
} as const satisfies Readonly<Record<PearlAbyssItemLocale, string>>;

const COMBINING_MARK = /\p{Mark}/u;
const LATIN_CHARACTER = /\p{Script_Extensions=Latin}/u;
const REMOVED_SEPARATOR = /[\p{White_Space}\p{Punctuation}]/u;

export function foldCatalogItemName(value: string, locale: PearlAbyssItemLocale): string {
  const decomposed = value.trim().normalize("NFKC").toLocaleLowerCase(BCP_47_TAGS[locale]).normalize("NFKD");
  let result = "";
  let precedingBaseIsLatin = false;

  for (const character of decomposed) {
    if (COMBINING_MARK.test(character)) {
      if (!precedingBaseIsLatin) result += character;
      continue;
    }
    if (REMOVED_SEPARATOR.test(character)) {
      precedingBaseIsLatin = false;
      continue;
    }
    result += character;
    precedingBaseIsLatin = LATIN_CHARACTER.test(character);
  }

  return result;
}

export interface CatalogItemNameSearchInput {
  readonly locale: PearlAbyssItemLocale;
  readonly query: string;
  readonly first: number;
}

export interface CatalogItemNameSearchSuccess {
  readonly ok: true;
  readonly itemPositions: readonly number[];
  readonly totalCount: number;
}

export interface CatalogItemNameSearchQueryLengthFailure {
  readonly ok: false;
  readonly code: "QUERY_LENGTH_OUT_OF_RANGE";
  readonly foldedQueryLength: number;
  readonly minimum: 3;
  readonly maximum: number;
}

export interface CatalogItemNameSearchFirstFailure {
  readonly ok: false;
  readonly code: "FIRST_OUT_OF_RANGE";
  readonly received: number;
  readonly minimum: 1;
  readonly maximum: 100;
}

export type CatalogItemNameSearchFailure = CatalogItemNameSearchQueryLengthFailure | CatalogItemNameSearchFirstFailure;

export type CatalogItemNameSearchResult = CatalogItemNameSearchSuccess | CatalogItemNameSearchFailure;

export interface CatalogItemNameSearchExecution {
  readonly result: CatalogItemNameSearchResult;
  readonly foldedQueryLength: number;
  readonly candidateCount: number;
}

export interface CatalogItemNameSearch {
  search(input: CatalogItemNameSearchInput): CatalogItemNameSearchResult;
  searchWithMetrics(input: CatalogItemNameSearchInput): CatalogItemNameSearchExecution;
}

export const catalogItemNameSearch: CatalogItemNameSearch = Object.freeze({
  search(input: CatalogItemNameSearchInput): CatalogItemNameSearchResult {
    return searchCatalogItemNames(input).result;
  },
  searchWithMetrics(input: CatalogItemNameSearchInput): CatalogItemNameSearchExecution {
    return searchCatalogItemNames(input);
  },
});

function searchCatalogItemNames(input: CatalogItemNameSearchInput): CatalogItemNameSearchExecution {
  const foldedQuery = foldCatalogItemName(input.query, input.locale);
  const foldedQueryLength = Array.from(foldedQuery).length;
  if (
    foldedQueryLength < MINIMUM_QUERY_LENGTH ||
    foldedQueryLength > generatedCatalogSearchArtifact.maxFoldedItemNameCodePoints
  ) {
    return {
      foldedQueryLength,
      candidateCount: 0,
      result: {
        ok: false,
        code: "QUERY_LENGTH_OUT_OF_RANGE",
        foldedQueryLength,
        minimum: MINIMUM_QUERY_LENGTH,
        maximum: generatedCatalogSearchArtifact.maxFoldedItemNameCodePoints,
      },
    };
  }
  if (!Number.isSafeInteger(input.first) || input.first < MINIMUM_FIRST || input.first > MAXIMUM_FIRST) {
    return {
      foldedQueryLength,
      candidateCount: 0,
      result: {
        ok: false,
        code: "FIRST_OUT_OF_RANGE",
        received: input.first,
        minimum: MINIMUM_FIRST,
        maximum: MAXIMUM_FIRST,
      },
    };
  }

  const searchKeys = generatedCatalogSearchArtifact.searchKeys[input.locale];
  const index = generatedCatalogSearchArtifact.indexes[input.locale];
  const candidateRange = shortestPostingRange(index, foldedQuery);
  if (candidateRange === null) {
    return {
      foldedQueryLength,
      candidateCount: 0,
      result: { ok: true, itemPositions: [], totalCount: 0 },
    };
  }

  const matchingPositions: number[] = [];
  for (let posting = candidateRange.start; posting < candidateRange.end; posting += 1) {
    const itemPosition = index.postings.valueAt(posting);
    if (itemPosition === undefined) continue;
    if (searchKeys.valueAt(itemPosition)?.includes(foldedQuery)) matchingPositions.push(itemPosition);
  }
  matchingPositions.sort((left, right) => compareMatches(left, right, searchKeys, foldedQuery));
  return {
    foldedQueryLength,
    candidateCount: candidateRange.end - candidateRange.start,
    result: {
      ok: true,
      itemPositions: matchingPositions.slice(0, input.first),
      totalCount: matchingPositions.length,
    },
  };
}

interface PostingRange {
  readonly start: number;
  readonly end: number;
}

function shortestPostingRange(index: CompactGramIndex, foldedQuery: string): PostingRange | null {
  let shortest: PostingRange | undefined;
  for (const gram of distinctTrigrams(foldedQuery)) {
    const gramPosition = sortedStringIndexOf(index.grams, gram);
    if (gramPosition === -1) return null;
    const start = index.offsets.valueAt(gramPosition);
    const end = index.offsets.valueAt(gramPosition + 1);
    if (start === undefined || end === undefined) return null;
    if (shortest === undefined || end - start < shortest.end - shortest.start) shortest = { start, end };
  }
  return shortest ?? null;
}

function distinctTrigrams(value: string): ReadonlySet<string> {
  const characters = Array.from(value);
  const grams = new Set<string>();
  for (let index = 0; index + 2 < characters.length; index += 1) {
    grams.add(`${characters[index]}${characters[index + 1]}${characters[index + 2]}`);
  }
  return grams;
}

function sortedStringIndexOf(values: CompactGramIndex["grams"], sought: string): number {
  let lower = 0;
  let upper = values.length - 1;
  while (lower <= upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const candidate = values.valueAt(middle);
    if (candidate === undefined) return -1;
    if (candidate === sought) return middle;
    if (candidate < sought) lower = middle + 1;
    else upper = middle - 1;
  }
  return -1;
}

function compareMatches(
  leftPosition: number,
  rightPosition: number,
  searchKeys: GeneratedCatalogSearchArtifact["searchKeys"][PearlAbyssItemLocale],
  foldedQuery: string,
): number {
  const leftKey = searchKeys.valueAt(leftPosition);
  const rightKey = searchKeys.valueAt(rightPosition);
  if (leftKey === undefined || rightKey === undefined) return leftPosition - rightPosition;
  const categoryDifference = matchCategory(leftKey, foldedQuery) - matchCategory(rightKey, foldedQuery);
  if (categoryDifference !== 0) return categoryDifference;
  const nameDifference = compareStrings(leftKey, rightKey);
  if (nameDifference !== 0) return nameDifference;
  return (
    (generatedCatalogSearchArtifact.itemIds.valueAt(leftPosition) ?? Number.MAX_SAFE_INTEGER) -
    (generatedCatalogSearchArtifact.itemIds.valueAt(rightPosition) ?? Number.MAX_SAFE_INTEGER)
  );
}

function matchCategory(searchKey: string, foldedQuery: string): number {
  if (searchKey === foldedQuery) return 0;
  if (searchKey.startsWith(foldedQuery)) return 1;
  return 2;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
