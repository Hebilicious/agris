import assert from "node:assert/strict";
import type { GatewayPlugin } from "@graphql-hive/gateway-runtime";
import { Effect } from "effect";

import { createCatalogSubgraph } from "../../packages/catalog-subgraph/src/index.ts";
import { PEARL_ABYSS_REGION_HOSTS } from "../../packages/pearl-abyss/src/protocol/regions.ts";
import {
  executeAgrisProxy,
  handleAgrisProxyRequest,
  type AgrisProxyRuntimeEnv,
} from "../../apps/gateway/src/gateway.ts";
import {
  executeMarketSubgraph,
  PearlAbyssCoordination,
  type PearlAbyssCoordinatorPort,
} from "../../apps/market/src/market.ts";
import {
  dataTableStepArgument,
  integerStepArgument,
  noStepArguments,
  step,
  type DataTable,
  type ExecutableFeatureManifest,
  type StepDefinition,
} from "../support/manifest.ts";

/** How the fake Pearl Abyss behind every coordinator answers. */
type PearlAbyssBehaviour =
  | "throttled"
  | "http-500"
  | "answers"
  | "eu-answers-na-unreadable"
  /** Not Pearl Abyss: the market subgraph itself refuses every read, asking the gateway to retry at once. */
  | "market-refuses-retry-at-once";

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: GraphqlBody;
}

interface GraphqlBody {
  readonly data?: unknown;
  readonly errors?: readonly GraphqlError[];
}

interface GraphqlError {
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly extensions?: { readonly code?: string };
}

interface MarketErrorSemanticsWorld {
  behaviour?: PearlAbyssBehaviour;
  /** Requests that reached Pearl Abyss, past the coordinator's limiter. */
  pearlAbyssRequests: number;
  answers: Answer[];
  /** Each data-table row's expectation, in the order of `answers`. */
  expectations: string[];
  /** The edge cache's stored answers, by cache key. */
  edge: Map<string, Response>;
  /** Whether every stored answer is past its freshness window, so a request refreshes it. */
  edgeExpired: boolean;
  /** The gateway's Envelop plugins; absent runs the gateway's own. */
  plugins?: readonly GatewayPlugin[];
}

const INTERNAL_ERROR_TEXT = "internal plugin detail 7f3a";

const catalog = createCatalogSubgraph();
const EU_HOST = PEARL_ABYSS_REGION_HOSTS.EU;
const NA_HOST = PEARL_ABYSS_REGION_HOSTS.NA;

const SUMMARY_QUERY = `{ market(region: EU) { items(ids: ["10006"]) { basePrice } } }`;

const steps: readonly StepDefinition<MarketErrorSemanticsWorld>[] = [
  step("the Pearl Abyss rate limiter refuses every request", noStepArguments, (world) => {
    world.behaviour = "throttled";
  }),
  step(
    "a gateway plugin that fails with an internal error, in a runtime whose NODE_ENV is development",
    noStepArguments,
    (world) => {
      world.plugins = [
        {
          onExecute: () => {
            throw new Error(INTERNAL_ERROR_TEXT);
          },
        },
      ];
      // Yoga includes the original error and its stack when NODE_ENV is development, unless told otherwise.
      return Effect.asVoid(
        Effect.acquireRelease(
          Effect.sync(() => {
            const previous = process.env.NODE_ENV;
            process.env.NODE_ENV = "development";
            return previous;
          }),
          (previous) =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.NODE_ENV;
              else process.env.NODE_ENV = previous;
            }),
        ),
      );
    },
  ),
  step("no error carries the internal error's message, its stack or the original error", noStepArguments, (world) => {
    const answer = onlyAnswer(world);
    const errors = answer.body.errors ?? [];
    assert.ok(errors.length > 0, JSON.stringify(answer.body));
    const text = JSON.stringify(answer.body);
    assert.doesNotMatch(text, new RegExp(INTERNAL_ERROR_TEXT, "u"));
    assert.doesNotMatch(text, /originalError|stack|\.ts:\d+/u);
  }),
  step("the market subgraph refuses every read with Retry-After 0", noStepArguments, (world) => {
    world.behaviour = "market-refuses-retry-at-once";
  }),
  step("Pearl Abyss answers every request with HTTP 500", noStepArguments, (world) => {
    world.behaviour = "http-500";
  }),
  step("Pearl Abyss answers every request", noStepArguments, (world) => {
    world.behaviour = "answers";
  }),
  step(
    "Pearl Abyss answers EU summaries and sends NA an answer that is not a Central Market response",
    noStepArguments,
    (world) => {
      world.behaviour = "eu-answers-na-unreadable";
    },
  ),

  step("the edge cache keeps the gateway's answer for the EU summary of item 10006", noStepArguments, async (world) => {
    const answer = await ask(world, SUMMARY_QUERY);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(world.edge.size, 1, "the edge cache kept no answer");
  }),
  step("that answer expires and the Pearl Abyss rate limiter then refuses every request", noStepArguments, (world) => {
    world.edgeExpired = true;
    world.behaviour = "throttled";
  }),
  step("a caller asks the gateway for the EU summary of item 10006", noStepArguments, async (world) => {
    world.answers.push(await ask(world, SUMMARY_QUERY));
  }),
  step("a caller asks the gateway for the name and EU market summary of item 44195", noStepArguments, async (world) => {
    world.answers.push(await ask(world, `{ item(id: "44195") { name marketSummary(region: EU) { basePrice } } }`));
  }),
  step(
    "a caller asks the gateway for each of these with a subrequest limit of 1",
    dataTableStepArgument,
    async (world, table) => {
      for (const row of rows(table, "path")) {
        world.answers.push(await ask(world, row.query, 1));
        world.expectations.push(row.expected);
      }
    },
  ),
  step("a caller asks the gateway for each of these", dataTableStepArgument, async (world, table) => {
    for (const row of rows(table, "message")) {
      world.answers.push(await ask(world, row.query));
      world.expectations.push(row.expected);
    }
  }),
  step("a caller asks the gateway for the EU and NA summaries of item 10006", noStepArguments, async (world) => {
    world.answers.push(
      await ask(
        world,
        `{ eu: market(region: EU) { items(ids: ["10006"]) { basePrice } } ` +
          `na: market(region: NA) { items(ids: ["10006"]) { basePrice } } }`,
      ),
    );
  }),

  step("the gateway answers 429 with Retry-After {int}", integerStepArgument, (world, seconds) => {
    const answer = onlyAnswer(world);
    assert.equal(answer.status, 429, JSON.stringify(answer.body));
    assert.equal(answer.headers.get("Retry-After"), String(seconds));
  }),
  step("the answer's only error is RATE_LIMITED at the market items", noStepArguments, (world) => {
    const errors = onlyAnswer(world).body.errors ?? [];
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.equal(errors[0]?.extensions?.code, "RATE_LIMITED");
    assert.deepEqual(errors[0]?.path?.slice(0, 2), ["market", "items"]);
  }),
  step(
    "the gateway answers 200 with the name Memory Fragment and a RATE_LIMITED market summary",
    noStepArguments,
    (world) => {
      const answer = onlyAnswer(world);
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      assert.deepEqual(answer.body.data, { item: { name: "Memory Fragment", marketSummary: null } });
      assert.deepEqual(
        answer.body.errors?.map((error) => [error.extensions?.code, error.path]),
        [["RATE_LIMITED", ["item", "marketSummary"]]],
      );
    },
  ),
  step("the gateway answers 503 that the Central Market subgraph is unavailable", noStepArguments, (world) => {
    const answer = onlyAnswer(world);
    assert.equal(answer.status, 503, JSON.stringify(answer.body));
    assert.deepEqual(
      answer.body.errors?.map((error) => error.message),
      ["Central Market subgraph unavailable"],
    );
  }),
  step(
    "the gateway answers 200 with the cached EU summary, served stale because its refresh failed",
    noStepArguments,
    (world) => {
      const answer = onlyAnswer(world);
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      assert.deepEqual(answer.body, { data: { market: { items: [{ basePrice: 10_006 }] } } });
      assert.equal(answer.headers.get("Cf-Cache-Status"), "STALE");
      assert.equal(answer.headers.get("X-Central-Market-Source"), "cache-stale");
      assert.equal(answer.headers.get("X-Central-Market-Refresh"), "failed");
    },
  ),
  step("the answer carries none of the gateway's internal headers", noStepArguments, (world) => {
    const internal = [...onlyAnswer(world).headers.keys()].filter((name) => /^x-agris-|-epoch-ms$/u.test(name));
    assert.deepEqual(internal, []);
  }),
  step("the answer is not stored", noStepArguments, (world) => {
    assert.equal(onlyAnswer(world).headers.get("Cache-Control"), "no-store");
  }),
  step("no answer is stored", noStepArguments, (world) => {
    assert.deepEqual(
      world.answers.map((answer) => answer.headers.get("Cache-Control")),
      world.answers.map(() => "no-store"),
    );
  }),
  step(
    "each answer is 200 with a QUERY_BUDGET_EXCEEDED error at its path, and no Pearl Abyss request",
    noStepArguments,
    (world) => {
      world.answers.forEach((answer, index) => {
        const path = world.expectations[index]?.split(".");
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        const errors = answer.body.errors ?? [];
        assert.ok(errors.length > 0, JSON.stringify(answer.body));
        for (const error of errors) {
          assert.equal(error.extensions?.code, "QUERY_BUDGET_EXCEEDED", JSON.stringify(error));
          assert.deepEqual(error.path?.slice(0, 2), path);
        }
      });
      assert.equal(world.pearlAbyssRequests, 0);
    },
  ),
  step(
    "each answer is 200 with BAD_USER_INPUT errors carrying its message, and no Pearl Abyss request",
    noStepArguments,
    (world) => {
      world.answers.forEach((answer, index) => {
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        const errors = answer.body.errors ?? [];
        assert.ok(errors.length > 0, "the answer has no errors");
        for (const error of errors) {
          assert.equal(error.extensions?.code, "BAD_USER_INPUT", JSON.stringify(error));
          assert.equal(error.message, world.expectations[index]);
        }
      });
      assert.equal(world.pearlAbyssRequests, 0);
    },
  ),
  step(
    "the gateway answers 200 with the EU summary and one UPSTREAM_UNAVAILABLE error at the NA items",
    noStepArguments,
    (world) => {
      const answer = onlyAnswer(world);
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      assert.deepEqual(answer.body.data, {
        eu: { items: [{ basePrice: 10_006 }] },
        na: { items: [{ basePrice: null }] },
      });
      assert.deepEqual(
        answer.body.errors?.map((error) => [error.extensions?.code, error.path, error.message]),
        [["UPSTREAM_UNAVAILABLE", ["na", "items", 0, "basePrice"], "The Central Market could not be read."]],
      );
    },
  ),
  step("no error mentions Pearl Abyss, Huffman or the response's shape", noStepArguments, (world) => {
    const text = JSON.stringify(onlyAnswer(world).body.errors);
    assert.doesNotMatch(text, /Pearl Abyss|Huffman|shape|header|codec/iu);
  }),
];

export const marketErrorSemanticsFeature: ExecutableFeatureManifest<MarketErrorSemanticsWorld> = {
  id: "market-error-semantics",
  uri: "tests/features/market-error-semantics.feature",
  createWorld: () => ({
    pearlAbyssRequests: 0,
    answers: [],
    expectations: [],
    edge: new Map(),
    edgeExpired: false,
  }),
  steps,
};

/** Ask the gateway one query, end to end: the private gateway, its market and catalog subgraphs, and Pearl Abyss. */
async function ask(world: MarketErrorSemanticsWorld, query: string, subrequestLimit = 50): Promise<Answer> {
  const env: AgrisProxyRuntimeEnv = {
    CATALOG: { fetch: (request) => catalog.fetch(request) },
    MARKET: {
      fetch: async (request, reserveBudget, reserveMarketSummary) =>
        world.behaviour === "market-refuses-retry-at-once"
          ? Response.json(
              { data: null, errors: [{ message: "Refused", extensions: { code: "RATE_LIMITED" } }] },
              { status: 429, headers: { "Retry-After": "0" } },
            )
          : executeMarketSubgraph(request, coordinators(world), reserveBudget, reserveMarketSummary),
    },
    subrequestLimit,
    ...(world.plugins === undefined ? {} : { plugins: world.plugins }),
  };
  const response = await handleAgrisProxyRequest(
    new Request("https://agris-proxy.internal/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }),
    env,
    (cacheKey, props) => edgeCache(world, cacheKey, () => executeAgrisProxy(env, props)),
  );
  return { status: response.status, headers: response.headers, body: graphqlBody(await response.json()) };
}

/**
 * The edge cache in front of execution, as Workers Cache behaves: a fresh stored answer is a HIT; otherwise the
 * operation executes, and when a stored answer exists and the execution failed with a 5xx (`stale-if-error`), the
 * stored answer is served STALE. Anything else is stored as its `Cache-Control` allows.
 */
async function edgeCache(
  world: MarketErrorSemanticsWorld,
  cacheKey: Request,
  execute: () => Promise<Response>,
): Promise<Response> {
  const stored = world.edge.get(cacheKey.url);
  if (stored !== undefined && !world.edgeExpired) return withCacheStatus(stored.clone(), "HIT");
  const response = await execute();
  if (stored !== undefined && response.status >= 500) return withCacheStatus(stored.clone(), "STALE");
  if (response.headers.get("Cache-Control") !== "no-store") {
    world.edge.set(cacheKey.url, response.clone());
    world.edgeExpired = false;
  }
  return withCacheStatus(response, stored === undefined ? "MISS" : "EXPIRED");
}

function withCacheStatus(response: Response, status: string): Response {
  const headers = new Headers(response.headers);
  headers.set("cf-cache-status", status);
  return new Response(response.body, { status: response.status, headers });
}

function coordinators(world: MarketErrorSemanticsWorld): (hostname: string) => PearlAbyssCoordinatorPort {
  // The real coordinator, behind a limiter that admits nothing, never reaches Pearl Abyss.
  const throttled: PearlAbyssCoordinatorPort = new PearlAbyssCoordination(6, {
    limit: async () => ({ success: false }),
  });
  return (hostname) => {
    if (world.behaviour === "throttled") return throttled;
    return { execute: (request) => pearlAbyss(world, hostname, request) };
  };
}

/** What the fake Pearl Abyss answers, as the coordinator passes it on. */
async function pearlAbyss(world: MarketErrorSemanticsWorld, hostname: string, request: Request): Promise<Response> {
  world.pearlAbyssRequests += 1;
  if (world.behaviour === "http-500") return new Response(null, { status: 500 });
  if (world.behaviour === "eu-answers-na-unreadable" && hostname === NA_HOST) {
    return bytesResponse(new TextEncoder().encode("\u0001\u0002 not a market answer"));
  }
  assert.ok(hostname === EU_HOST || hostname === NA_HOST, `unexpected Pearl Abyss host ${hostname}`);
  const body: unknown = await request.json();
  const searchResult =
    typeof body === "object" && body !== null && "searchResult" in body ? body.searchResult : undefined;
  assert.equal(typeof searchResult, "string", "only summary reads reach this fake Pearl Abyss");
  const ids = String(searchResult).split(",").map(Number);
  const rows = ids.map((itemId) => `${itemId}-1-${itemId}-3`).join("|");
  return bytesResponse(new TextEncoder().encode(JSON.stringify({ resultCode: 0, resultMsg: rows })));
}

function bytesResponse(bytes: Uint8Array<ArrayBuffer>): Response {
  return new Response(bytes, { status: 200, headers: { "Content-Length": String(bytes.byteLength) } });
}

function rows(table: DataTable, expectation: string): { readonly query: string; readonly expected: string }[] {
  return table.hashes.map((row) => {
    const query = row.query;
    const expected = row[expectation];
    assert.ok(query !== undefined && expected !== undefined, `each row needs a query and a ${expectation}`);
    return { query, expected };
  });
}

function onlyAnswer(world: MarketErrorSemanticsWorld): Answer {
  assert.equal(world.answers.length, 1);
  const answer = world.answers[0];
  assert.ok(answer !== undefined);
  return answer;
}

/* BOUNDARY: The gateway's answer is JSON; this test reads only the GraphQL response fields it asserts on. */
function graphqlBody(value: unknown): GraphqlBody {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), "the answer is a JSON object");
  // SAFETY: The assertions that read this body compare it against literal expectations, which fail on any other shape.
  return value as GraphqlBody;
}
