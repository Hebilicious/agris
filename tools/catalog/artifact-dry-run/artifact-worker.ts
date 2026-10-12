import { generatedCatalogSearchArtifact } from "@agris/catalog-subgraph/generated-catalog-search-artifact";
import { catalogItemNameSearch, foldCatalogItemName } from "@agris/catalog-subgraph/item-name-search";
import { PEARL_ABYSS_ITEM_LOCALES, type PearlAbyssItemLocale } from "@agris/pearl-abyss/locales";

const MINIMUM_QUERY_LENGTH = 3;
const QUERIES_PER_LOCALE = 309;
const TIMED_REPETITIONS_PER_QUERY = 3;
const OPERATIONS_PER_TIMING_SAMPLE = 100;
const RETAINED_CORPUS_VERSION = 1;

const RETAINED_KIND_COUNTS = {
  full: 64,
  prefix: 64,
  middle: 128,
  boundary: 44,
  miss: 9,
} as const;

type RetainedQueryKind = keyof typeof RETAINED_KIND_COUNTS;

interface RetainedSearchCase {
  readonly locale: PearlAbyssItemLocale;
  readonly kind: RetainedQueryKind;
  readonly query: string;
  readonly foldedQueryLength: number;
}

interface TimedQuery {
  readonly locale: PearlAbyssItemLocale;
  readonly durationMilliseconds: number;
  readonly resultChecksum: string;
}

export default {
  fetch(request: Request): Response {
    if (new URL(request.url).pathname === "/diagnostic") return searchDiagnostic();
    return Response.json({
      version: generatedCatalogSearchArtifact.version,
      normalizationVersion: generatedCatalogSearchArtifact.normalizationVersion,
      maxFoldedItemNameCodePoints: generatedCatalogSearchArtifact.maxFoldedItemNameCodePoints,
      sourceCatalogChecksums: generatedCatalogSearchArtifact.sourceCatalogChecksums,
      itemCount: generatedCatalogSearchArtifact.itemIds.length,
      gradeCount: generatedCatalogSearchArtifact.grades.length,
      locales: Object.fromEntries(
        PEARL_ABYSS_ITEM_LOCALES.map((locale) => {
          const index = generatedCatalogSearchArtifact.indexes[locale];
          return [
            locale,
            {
              displayNameCount: generatedCatalogSearchArtifact.displayNames[locale].length,
              searchKeyCount: generatedCatalogSearchArtifact.searchKeys[locale].length,
              gramCount: index.grams.length,
              offsetCount: index.offsets.length,
              postingCount: index.postings.length,
            },
          ];
        }),
      ),
    });
  },
};

function searchDiagnostic(): Response {
  const corpus = retainedSearchCorpus();
  for (const searchCase of corpus) searchAccepted(searchCase);
  const timings = measureSearchCorpus(corpus);
  const localeCases = PEARL_ABYSS_ITEM_LOCALES.map((locale) => summarizeLocale(locale, corpus, timings));
  const aggregateP95Milliseconds = percentile95(timings.map(({ durationMilliseconds }) => durationMilliseconds));
  const foldedQueryLengths = [...new Set(corpus.map(({ foldedQueryLength }) => foldedQueryLength))].sort(
    (left, right) => left - right,
  );
  const baseline = searchObservable("EN", "blackstone");
  return Response.json({
    operation: "catalogItemNameSearch.search/accepted/all-locales/retained-exact-corpus",
    corpusVersion: RETAINED_CORPUS_VERSION,
    localeCount: PEARL_ABYSS_ITEM_LOCALES.length,
    queryCount: corpus.length,
    queriesPerLocale: QUERIES_PER_LOCALE,
    timedRepetitionsPerQuery: TIMED_REPETITIONS_PER_QUERY,
    operationsPerTimingSample: OPERATIONS_PER_TIMING_SAMPLE,
    timingSampleCount: timings.length,
    totalOperations: timings.length * OPERATIONS_PER_TIMING_SAMPLE,
    timingMethod: "retained-query-micro-batches/per-operation",
    aggregateP95Milliseconds,
    foldedQueryLengthCoverage: {
      minimum: foldedQueryLengths[0],
      maximum: foldedQueryLengths.at(-1),
      lengths: foldedQueryLengths,
    },
    localeCases,
    observable: baseline,
  });
}

function measureSearchCorpus(corpus: readonly RetainedSearchCase[]): readonly TimedQuery[] {
  return corpus.flatMap((searchCase) =>
    Array.from({ length: TIMED_REPETITIONS_PER_QUERY }, () => {
      let result: ReturnType<typeof searchAccepted> | undefined;
      const startedAt = performance.now();
      for (let operation = 0; operation < OPERATIONS_PER_TIMING_SAMPLE; operation += 1) {
        result = searchAccepted(searchCase);
      }
      const durationMilliseconds = (performance.now() - startedAt) / OPERATIONS_PER_TIMING_SAMPLE;
      if (result === undefined) throw new TypeError("Retained search timing sample executed no operations");
      return {
        locale: searchCase.locale,
        durationMilliseconds,
        resultChecksum: resultObservable(result).returnedItemIdsChecksum,
      };
    }),
  );
}

function retainedSearchCorpus(): readonly RetainedSearchCase[] {
  const corpus = PEARL_ABYSS_ITEM_LOCALES.flatMap(retainedLocaleCorpus);
  if (corpus.length !== QUERIES_PER_LOCALE * PEARL_ABYSS_ITEM_LOCALES.length) {
    throw new TypeError("Retained exact-search corpus does not contain 3,708 queries");
  }
  return corpus;
}

function retainedLocaleCorpus(locale: PearlAbyssItemLocale): readonly RetainedSearchCase[] {
  const searchKeys = generatedCatalogSearchArtifact.searchKeys[locale];
  const displayNames = generatedCatalogSearchArtifact.displayNames[locale];
  const candidates: Record<Exclude<RetainedQueryKind, "miss">, string[]> = {
    full: [],
    prefix: [],
    middle: [],
    boundary: [],
  };
  for (let position = 0; position < searchKeys.length; position += 1) {
    const searchKey = searchKeys.valueAt(position);
    const displayName = displayNames.valueAt(position);
    if (searchKey === undefined || displayName === undefined) {
      throw new TypeError(`Retained corpus ${locale} source position ${position} is missing`);
    }
    const characters = Array.from(searchKey);
    if (characters.length < MINIMUM_QUERY_LENGTH) continue;
    candidates.full.push(searchKey);
    const prefixLength = Math.min(characters.length, MINIMUM_QUERY_LENGTH + (position % 14));
    candidates.prefix.push(characters.slice(0, prefixLength).join(""));
    const middleLength = [3, 4, 6, 8, 12, 16, 24, 32][position % 8] ?? MINIMUM_QUERY_LENGTH;
    if (characters.length >= middleLength) {
      const availableStarts = characters.length - middleLength + 1;
      const start = (Math.imul(position + 1, 2_654_435_761) >>> 0) % availableStarts;
      candidates.middle.push(characters.slice(start, start + middleLength).join(""));
    }
    const boundary = boundarySpan(displayName, locale);
    if (boundary !== undefined) candidates.boundary.push(boundary);
  }

  const selected = (Object.keys(candidates) as Array<Exclude<RetainedQueryKind, "miss">>).flatMap((kind) => {
    const queries = evenlySelect(candidates[kind], RETAINED_KIND_COUNTS[kind]);
    if (kind === "full") includeLongest(queries, candidates.full);
    return queries.map((query) => retainedSearchCase(locale, kind, query));
  });
  for (let miss = 0; miss < RETAINED_KIND_COUNTS.miss; miss += 1) {
    const searchCase = retainedSearchCase(locale, "miss", `guaranteed-miss-${locale}-${miss}-qxz`);
    const result = searchAccepted(searchCase);
    if (result.totalCount !== 0) throw new TypeError(`Retained corpus ${locale} miss unexpectedly matched`);
    selected.push(searchCase);
  }
  if (selected.length !== QUERIES_PER_LOCALE) {
    throw new TypeError(`Retained corpus ${locale} does not contain ${QUERIES_PER_LOCALE} queries`);
  }
  return selected;
}

function retainedSearchCase(locale: PearlAbyssItemLocale, kind: RetainedQueryKind, query: string): RetainedSearchCase {
  const foldedQuery = foldCatalogItemName(query, locale);
  const foldedQueryLength = Array.from(foldedQuery).length;
  if (
    foldedQueryLength < MINIMUM_QUERY_LENGTH ||
    foldedQueryLength > generatedCatalogSearchArtifact.maxFoldedItemNameCodePoints
  ) {
    throw new RangeError(`Retained corpus ${locale}/${kind} query length is outside the accepted range`);
  }
  if (foldCatalogItemName(foldedQuery, locale) !== foldedQuery) {
    throw new TypeError(`Retained corpus ${locale}/${kind} folding is not idempotent`);
  }
  return { locale, kind, query: foldedQuery, foldedQueryLength };
}

function boundarySpan(displayName: string, locale: PearlAbyssItemLocale): string | undefined {
  const characters = Array.from(displayName);
  const boundaryIndex = characters.findIndex((character) => /[\p{White_Space}\p{Punctuation}]/u.test(character));
  if (boundaryIndex <= 0 || boundaryIndex >= characters.length - 1) return undefined;
  const start = Math.max(0, boundaryIndex - 4);
  const end = Math.min(characters.length, boundaryIndex + 5);
  const folded = foldCatalogItemName(characters.slice(start, end).join(""), locale);
  return Array.from(folded).length >= MINIMUM_QUERY_LENGTH ? folded : undefined;
}

function evenlySelect(candidates: readonly string[], count: number): string[] {
  const unique = [...new Set(candidates)];
  if (unique.length < count) throw new TypeError(`Retained corpus candidate pool has only ${unique.length}/${count}`);
  return Array.from({ length: count }, (_, index) => unique[Math.floor((index * unique.length) / count)]).flatMap(
    (candidate) => (candidate === undefined ? [] : [candidate]),
  );
}

function includeLongest(selected: string[], candidates: readonly string[]): void {
  const longest = candidates.reduce((current, candidate) =>
    Array.from(candidate).length > Array.from(current).length ? candidate : current,
  );
  if (!selected.includes(longest)) selected[selected.length - 1] = longest;
}

function summarizeLocale(
  locale: PearlAbyssItemLocale,
  corpus: readonly RetainedSearchCase[],
  timings: readonly TimedQuery[],
) {
  const localeCorpus = corpus.filter((searchCase) => searchCase.locale === locale);
  const localeTimings = timings.filter((timing) => timing.locale === locale);
  const foldedLengths = localeCorpus.map(({ foldedQueryLength }) => foldedQueryLength);
  return {
    locale,
    queryCount: localeCorpus.length,
    timingSampleCount: localeTimings.length,
    operationCount: localeTimings.length * OPERATIONS_PER_TIMING_SAMPLE,
    p95Milliseconds: percentile95(localeTimings.map(({ durationMilliseconds }) => durationMilliseconds)),
    foldedQueryLengthMinimum: Math.min(...foldedLengths),
    foldedQueryLengthMaximum: Math.max(...foldedLengths),
    foldedQueryLengths: [...new Set(foldedLengths)].sort((left, right) => left - right),
    kindCounts: Object.fromEntries(
      (Object.keys(RETAINED_KIND_COUNTS) as RetainedQueryKind[]).map((kind) => [
        kind,
        localeCorpus.filter((searchCase) => searchCase.kind === kind).length,
      ]),
    ),
    observableChecksum: checksum(localeTimings.map(({ resultChecksum }) => resultChecksum)),
  };
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.ceil(sorted.length * 0.95) - 1];
  if (value === undefined) throw new TypeError("Search diagnostic produced no timing samples");
  return value;
}

function searchAccepted(input: RetainedSearchCase) {
  const result = catalogItemNameSearch.search({ locale: input.locale, query: input.query, first: 100 });
  if (!result.ok) throw new TypeError("Retained accepted search did not produce a result");
  return result;
}

function searchObservable(locale: PearlAbyssItemLocale, query: string) {
  const result = catalogItemNameSearch.search({ locale, query, first: 100 });
  if (!result.ok) throw new TypeError("Accepted observable search did not produce a result");
  return resultObservable(result);
}

function resultObservable(result: Extract<ReturnType<typeof catalogItemNameSearch.search>, { readonly ok: true }>) {
  return {
    ok: true,
    returnedCount: result.itemPositions.length,
    returnedItemIdsChecksum: checksum(
      result.itemPositions.map((position) => generatedCatalogSearchArtifact.itemIds.valueAt(position) ?? 0),
    ),
    totalCount: result.totalCount,
  } as const;
}

function checksum(values: readonly (number | string)[]): string {
  let hash = 2_166_136_261;
  for (const value of values) {
    for (const character of String(value)) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16_777_619);
    }
    hash ^= 44;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
