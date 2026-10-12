import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import * as v from "valibot";
import WebSocket, { type RawData } from "ws";

import { PEARL_ABYSS_ITEM_LOCALES } from "@agris/pearl-abyss/locales";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const artifactDirectory = resolve(repositoryRoot, ".artifacts/catalog-release");
const retainedMemoryLimitBytes = 96 * 1_024 * 1_024;
const compressedUploadLimitBytes = 9 * 1_024 * 1_024;
const searchP95LimitMilliseconds = 0.25;
const productionSearchResponseSchema = v.strictObject({
  data: v.strictObject({
    searchItems: v.strictObject({
      items: v.array(v.looseObject({ id: v.string() })),
      totalCount: v.number(),
    }),
  }),
});
const searchObservableSchema = v.strictObject({
  ok: v.literal(true),
  returnedCount: v.number(),
  returnedItemIdsChecksum: v.string(),
  totalCount: v.number(),
});
const retainedKindCountsSchema = v.strictObject({
  full: v.number(),
  prefix: v.number(),
  middle: v.number(),
  boundary: v.number(),
  miss: v.number(),
});
const localeSearchCaseSchema = v.strictObject({
  locale: v.string(),
  queryCount: v.number(),
  timingSampleCount: v.number(),
  operationCount: v.number(),
  p95Milliseconds: v.number(),
  foldedQueryLengthMinimum: v.number(),
  foldedQueryLengthMaximum: v.number(),
  foldedQueryLengths: v.array(v.number()),
  kindCounts: retainedKindCountsSchema,
  observableChecksum: v.string(),
});
const searchDiagnosticSchema = v.strictObject({
  operation: v.string(),
  corpusVersion: v.literal(1),
  localeCount: v.number(),
  queryCount: v.number(),
  queriesPerLocale: v.number(),
  timedRepetitionsPerQuery: v.number(),
  operationsPerTimingSample: v.number(),
  timingSampleCount: v.number(),
  totalOperations: v.number(),
  timingMethod: v.literal("retained-query-micro-batches/per-operation"),
  aggregateP95Milliseconds: v.number(),
  foldedQueryLengthCoverage: v.strictObject({
    minimum: v.number(),
    maximum: v.number(),
    lengths: v.array(v.number()),
  }),
  localeCases: v.array(localeSearchCaseSchema),
  observable: searchObservableSchema,
});
const inspectorTargetListSchema = v.pipe(v.array(v.looseObject({ webSocketDebuggerUrl: v.string() })), v.minLength(1));
const heapUsageSchema = v.looseObject({
  usedSize: v.number(),
  embedderHeapUsedSize: v.optional(v.number(), 0),
  backingStorageSize: v.optional(v.number(), 0),
});
const inspectorHeapUsageResponseSchema = v.union([
  v.looseObject({ id: v.number(), result: heapUsageSchema }),
  v.looseObject({ id: v.number(), error: v.looseObject({ message: v.optional(v.string()) }) }),
]);

type ProductionSearchResponse = v.InferOutput<typeof productionSearchResponseSchema>;
type SearchDiagnostic = v.InferOutput<typeof searchDiagnosticSchema>;
type HeapUsage = v.InferOutput<typeof heapUsageSchema>;

const report = await runReleaseDiagnostic();
await mkdir(artifactDirectory, { recursive: true });
await writeFile(resolve(artifactDirectory, "catalog-worker-diagnostic.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ event: "catalog-release-diagnostic", ...report }));
if (!report.passed) process.exitCode = 1;

async function runReleaseDiagnostic() {
  const production = await withWorkerdArtifact(
    resolve(artifactDirectory, "catalog-upload/index.js"),
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
      const first = v.parse(productionSearchResponseSchema, await firstResponse.json());
      const firstSearchMilliseconds = performance.now() - firstSearchStartedAt;
      const secondResponse = await request();
      if (!secondResponse.ok) throw new Error(`Diagnostic HTTP request failed with ${secondResponse.status}`);
      const second = v.parse(productionSearchResponseSchema, await secondResponse.json());
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

  const search = await withWorkerdArtifact(
    resolve(artifactDirectory, "search-upload/artifact-worker.js"),
    "2026-08-31",
    async ({ miniflare }) => {
      const response = await miniflare.dispatchFetch("http://search.internal/diagnostic");
      if (!response.ok) throw new Error(`Diagnostic HTTP request failed with ${response.status}`);
      const diagnostic = v.parse(searchDiagnosticSchema, await response.json());
      validateSearchDiagnostic(diagnostic);
      return diagnostic;
    },
  );
  const uploadScript = await readFile(resolve(artifactDirectory, "catalog-upload/index.js"));
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
    runtime: "workerd via Miniflare against retained Wrangler dry-run artifacts",
    productionConfiguration: {
      artifact: "catalog-upload/index.js",
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
      rootPath: artifactDirectory,
      scriptPath: relative(artifactDirectory, scriptPath),
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
  const targets = v.parse(inspectorTargetListSchema, await response.json());
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
      const parsed = v.safeParse(inspectorHeapUsageResponseSchema, JSON.parse(rawDataText(data)));
      if (!parsed.success || parsed.output.id !== 1) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      if ("error" in parsed.output) reject(new Error("Workerd inspector command Runtime.getHeapUsage failed"));
      else resolveResponse(parsed.output.result);
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
