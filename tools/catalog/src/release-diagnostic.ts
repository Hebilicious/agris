import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Option, Schema, type SchemaAST } from "effect";
import WebSocket, { type RawData } from "ws";

import { PEARL_ABYSS_ITEM_LOCALES } from "@agris/pearl-abyss/locales";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const artifactDirectory = resolve(repositoryRoot, ".artifacts/catalog-release");
/** The catalog Worker's entrypoint as `moon run infra:bundle` bundles it, and the search Worker. */
const catalogBundle = resolve(repositoryRoot, ".artifacts/alchemy-bundles/HostCatalog/index.js");
const searchBundle = resolve(artifactDirectory, "CatalogSearchArtifact/artifact-worker.js");
const retainedMemoryLimitBytes = 96 * 1_024 * 1_024;
const compressedUploadLimitBytes = 9 * 1_024 * 1_024;
const searchP95LimitMilliseconds = 0.25;
/** Decoding refuses any key a schema does not name, except inside `openStruct`, which admits extra keys. */
const STRICT: SchemaAST.ParseOptions = { onExcessProperty: "error" };
/** A struct that also admits keys it does not name, even when decoded with `STRICT`. */
const openStruct = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)]);

const productionSearchResponseSchema = Schema.Struct({
  data: Schema.Struct({
    searchItems: Schema.Struct({
      items: Schema.Array(openStruct({ id: Schema.String })),
      totalCount: Schema.Number,
    }),
  }),
});
const searchObservableSchema = Schema.Struct({
  ok: Schema.Literal(true),
  returnedCount: Schema.Number,
  returnedItemIdsChecksum: Schema.String,
  totalCount: Schema.Number,
});
const retainedKindCountsSchema = Schema.Struct({
  full: Schema.Number,
  prefix: Schema.Number,
  middle: Schema.Number,
  boundary: Schema.Number,
  miss: Schema.Number,
});
const localeSearchCaseSchema = Schema.Struct({
  locale: Schema.String,
  queryCount: Schema.Number,
  timingSampleCount: Schema.Number,
  operationCount: Schema.Number,
  p95Milliseconds: Schema.Number,
  foldedQueryLengthMinimum: Schema.Number,
  foldedQueryLengthMaximum: Schema.Number,
  foldedQueryLengths: Schema.Array(Schema.Number),
  kindCounts: retainedKindCountsSchema,
  observableChecksum: Schema.String,
});
const searchDiagnosticSchema = Schema.Struct({
  operation: Schema.String,
  corpusVersion: Schema.Literal(1),
  localeCount: Schema.Number,
  queryCount: Schema.Number,
  queriesPerLocale: Schema.Number,
  timedRepetitionsPerQuery: Schema.Number,
  operationsPerTimingSample: Schema.Number,
  timingSampleCount: Schema.Number,
  totalOperations: Schema.Number,
  timingMethod: Schema.Literal("retained-query-micro-batches/per-operation"),
  aggregateP95Milliseconds: Schema.Number,
  foldedQueryLengthCoverage: Schema.Struct({
    minimum: Schema.Number,
    maximum: Schema.Number,
    lengths: Schema.Array(Schema.Number),
  }),
  localeCases: Schema.Array(localeSearchCaseSchema),
  observable: searchObservableSchema,
});
const inspectorTargetListSchema = Schema.Array(Schema.Struct({ webSocketDebuggerUrl: Schema.String })).check(
  Schema.isMinLength(1),
);
const heapUsageSchema = Schema.Struct({
  usedSize: Schema.Number,
  embedderHeapUsedSize: Schema.optional(Schema.Number),
  backingStorageSize: Schema.optional(Schema.Number),
});
const inspectorHeapUsageResponseSchema = Schema.Union([
  Schema.Struct({ id: Schema.Number, result: heapUsageSchema }),
  Schema.Struct({ id: Schema.Number, error: Schema.Struct({ message: Schema.optional(Schema.String) }) }),
]);

const decodeProductionSearchResponse = Schema.decodeUnknownSync(productionSearchResponseSchema, STRICT);
const decodeSearchDiagnostic = Schema.decodeUnknownSync(searchDiagnosticSchema, STRICT);
const decodeInspectorTargetList = Schema.decodeUnknownSync(inspectorTargetListSchema);
const decodeInspectorHeapUsageResponse = Schema.decodeUnknownOption(inspectorHeapUsageResponseSchema);

type ProductionSearchResponse = typeof productionSearchResponseSchema.Type;
type SearchDiagnostic = typeof searchDiagnosticSchema.Type;

/** The inspector's heap usage, with the components an older runtime leaves out counted as zero. */
interface HeapUsage {
  readonly usedSize: number;
  readonly embedderHeapUsedSize: number;
  readonly backingStorageSize: number;
}

const report = await runReleaseDiagnostic();
await mkdir(artifactDirectory, { recursive: true });
await writeFile(resolve(artifactDirectory, "catalog-worker-diagnostic.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ event: "catalog-release-diagnostic", ...report }));
if (!report.passed) process.exitCode = 1;

async function runReleaseDiagnostic() {
  const production = await withWorkerdArtifact(
    catalogBundle,
    "2026-08-24",
    async ({ miniflare, inspectorUrl, startupMilliseconds }) => {
      const request = () =>
        miniflare.dispatchFetch("http://catalog.internal/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query:
              'query ReleaseSearch { searchItems(query: "blackstone", locale: EN, first: 100) { totalCount items { id locale } } }',
          }),
        });
      const firstSearchStartedAt = performance.now();
      const firstResponse = await request();
      if (!firstResponse.ok) throw new Error(`Diagnostic HTTP request failed with ${firstResponse.status}`);
      const first = decodeProductionSearchResponse(await firstResponse.json());
      const firstSearchMilliseconds = performance.now() - firstSearchStartedAt;
      const secondResponse = await request();
      if (!secondResponse.ok) throw new Error(`Diagnostic HTTP request failed with ${secondResponse.status}`);
      const second = decodeProductionSearchResponse(await secondResponse.json());
      const heap = await inspectorHeapUsage(inspectorUrl);
      return {
        startupMilliseconds,
        firstSearchMilliseconds,
        retainedMemoryBytes: heap.usedSize + heap.embedderHeapUsedSize + heap.backingStorageSize,
        retainedMemoryComponents: heap,
        repeatedRequestOutputParity: JSON.stringify(first) === JSON.stringify(second),
        observable: productionSearchObservable(first),
      };
    },
  );

  const search = await withWorkerdArtifact(searchBundle, "2026-08-24", async ({ miniflare }) => {
    const response = await miniflare.dispatchFetch("http://search.internal/diagnostic");
    if (!response.ok) throw new Error(`Diagnostic HTTP request failed with ${response.status}`);
    const diagnostic = decodeSearchDiagnostic(await response.json());
    validateSearchDiagnostic(diagnostic);
    return diagnostic;
  });
  const uploadScript = await readFile(catalogBundle);
  const compressedUploadBytes = gzipSync(uploadScript).byteLength;
  const failingSearchCases = search.localeCases.filter(
    ({ p95Milliseconds }) => p95Milliseconds > searchP95LimitMilliseconds,
  );
  const gates = {
    retainedMemory: {
      actualBytes: production.retainedMemoryBytes,
      limitBytes: retainedMemoryLimitBytes,
      passed: production.retainedMemoryBytes < retainedMemoryLimitBytes,
    },
    compressedUpload: {
      actualBytes: compressedUploadBytes,
      limitBytes: compressedUploadLimitBytes,
      passed: compressedUploadBytes < compressedUploadLimitBytes,
    },
    searchP95: {
      actualMilliseconds: search.aggregateP95Milliseconds,
      limitMilliseconds: searchP95LimitMilliseconds,
      failingCaseCount: failingSearchCases.length,
      passed: search.aggregateP95Milliseconds <= searchP95LimitMilliseconds && failingSearchCases.length === 0,
      timingIsDiagnostic: true,
    },
    repeatedProductionOutput: { passed: production.repeatedRequestOutputParity },
    observableOutputParity: {
      passed: JSON.stringify(production.observable) === JSON.stringify(search.observable),
    },
  };

  return {
    passed: Object.values(gates).every((gate) => gate.passed),
    runtime: "workerd via Miniflare against the Alchemy bundles",
    productionConfiguration: {
      artifact: relative(repositoryRoot, catalogBundle),
      compatibilityDate: "2026-08-24",
      compatibilityFlags: ["nodejs_compat"],
    },
    catalog: {
      ...production,
      retainedMemoryLimitBytes,
      compressedUploadBytes,
      compressedUploadLimitBytes,
    },
    search: { ...search, p95LimitMilliseconds: searchP95LimitMilliseconds, timingIsDiagnostic: true },
    gates,
  };
}

function validateSearchDiagnostic(search: SearchDiagnostic): void {
  const expectedQueryCount = 3_708;
  const expectedTimedSearchCount = 11_124;
  if (
    search.localeCount !== PEARL_ABYSS_ITEM_LOCALES.length ||
    search.queryCount !== expectedQueryCount ||
    search.queriesPerLocale !== 309 ||
    search.timedRepetitionsPerQuery !== 3 ||
    search.operationsPerTimingSample !== 100 ||
    search.timingSampleCount !== expectedTimedSearchCount ||
    search.totalOperations !== 1_112_400
  ) {
    throw new TypeError("Retained search diagnostic does not match the frozen 3,708-query corpus");
  }
  if (search.localeCases.length !== PEARL_ABYSS_ITEM_LOCALES.length) {
    throw new TypeError("Retained search diagnostic locale count is inconsistent");
  }
  const expectedLocales = [...PEARL_ABYSS_ITEM_LOCALES].sort();
  const observedLocales = search.localeCases.map(({ locale }) => locale).sort();
  if (JSON.stringify(observedLocales) !== JSON.stringify(expectedLocales)) {
    throw new TypeError("Retained search diagnostic locale identity is incomplete");
  }
  for (const localeCase of search.localeCases) {
    if (
      localeCase.queryCount !== 309 ||
      localeCase.timingSampleCount !== 927 ||
      localeCase.operationCount !== 92_700 ||
      localeCase.kindCounts.full !== 64 ||
      localeCase.kindCounts.prefix !== 64 ||
      localeCase.kindCounts.middle !== 128 ||
      localeCase.kindCounts.boundary !== 44 ||
      localeCase.kindCounts.miss !== 9
    ) {
      throw new TypeError(`Retained search diagnostic ${localeCase.locale} corpus is incomplete`);
    }
    if (
      localeCase.foldedQueryLengthMinimum !== Math.min(...localeCase.foldedQueryLengths) ||
      localeCase.foldedQueryLengthMaximum !== Math.max(...localeCase.foldedQueryLengths) ||
      localeCase.foldedQueryLengthMinimum < 3 ||
      localeCase.foldedQueryLengthMaximum > 69
    ) {
      throw new TypeError(`Retained search diagnostic ${localeCase.locale} length coverage is inconsistent`);
    }
  }
  const coveredLengths = [...new Set(search.localeCases.flatMap(({ foldedQueryLengths }) => foldedQueryLengths))].sort(
    (left, right) => left - right,
  );
  if (
    search.foldedQueryLengthCoverage.minimum !== Math.min(...coveredLengths) ||
    search.foldedQueryLengthCoverage.maximum !== Math.max(...coveredLengths) ||
    search.foldedQueryLengthCoverage.minimum !== 3 ||
    search.foldedQueryLengthCoverage.maximum !== 69 ||
    JSON.stringify(search.foldedQueryLengthCoverage.lengths) !== JSON.stringify(coveredLengths)
  ) {
    throw new TypeError("Retained search diagnostic aggregate length coverage is inconsistent");
  }
}

async function withWorkerdArtifact<Value>(
  scriptPath: string,
  compatibilityDate: string,
  run: (runtime: {
    readonly miniflare: Miniflare;
    readonly inspectorUrl: URL;
    readonly startupMilliseconds: number;
  }) => Promise<Value>,
): Promise<Value> {
  const startedAt = performance.now();
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: dirname(scriptPath),
      scriptPath: basename(scriptPath),
      modules: true,
      compatibilityDate,
      compatibilityFlags: ["nodejs_compat"],
      inspectorPort: 0,
      logRequests: false,
    }),
  );
  try {
    await miniflare.ready;
    const startupMilliseconds = performance.now() - startedAt;
    const inspectorUrl = await miniflare.getInspectorURL();
    return await run({ miniflare, inspectorUrl, startupMilliseconds });
  } finally {
    await miniflare.dispose();
  }
}

async function inspectorHeapUsage(inspectorUrl: URL): Promise<HeapUsage> {
  const targetListUrl = new URL("/json", inspectorUrl);
  targetListUrl.protocol = "http:";
  const response = await fetch(targetListUrl);
  if (!response.ok) throw new Error(`Workerd inspector target request failed with ${response.status}`);
  const targets = decodeInspectorTargetList(await response.json());
  const target = targets[0];
  if (target === undefined) throw new TypeError("Workerd inspector returned no targets");
  const webSocketDebuggerUrl = target.webSocketDebuggerUrl;
  const socket = new WebSocket(webSocketDebuggerUrl, { origin: "http://localhost" });
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", () => resolveOpen());
    socket.once("error", (error) => reject(new Error(`Workerd inspector WebSocket failed: ${error.message}`)));
  });
  try {
    return await requestHeapUsage(socket);
  } finally {
    socket.close();
  }
}

async function requestHeapUsage(socket: WebSocket): Promise<HeapUsage> {
  return new Promise((resolveResponse, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Workerd inspector command Runtime.getHeapUsage timed out"));
    }, 5_000);
    const onMessage = (data: RawData): void => {
      const parsed = Option.getOrUndefined(decodeInspectorHeapUsageResponse(JSON.parse(rawDataText(data))));
      if (parsed === undefined || parsed.id !== 1) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      if ("error" in parsed) {
        reject(new Error("Workerd inspector command Runtime.getHeapUsage failed"));
        return;
      }
      resolveResponse({
        usedSize: parsed.result.usedSize,
        embedderHeapUsedSize: parsed.result.embedderHeapUsedSize ?? 0,
        backingStorageSize: parsed.result.backingStorageSize ?? 0,
      });
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ id: 1, method: "Runtime.getHeapUsage" }));
  });
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function productionSearchObservable(value: ProductionSearchResponse) {
  const result = value.data.searchItems;
  const itemIds = result.items.map((item) => item.id);
  return {
    ok: true,
    returnedCount: itemIds.length,
    returnedItemIdsChecksum: checksum(itemIds),
    totalCount: result.totalCount,
  };
}

function checksum(values: readonly string[]): string {
  let hash = 2_166_136_261;
  for (const value of values) {
    for (const character of value) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16_777_619);
    }
    hash ^= 44;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
