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
import { executeMarketSubgraph, type PearlAbyssCoordinatorPort } from "../../apps/market/src/market.ts";
import {
  dataTableStepArgument,
  noStepArguments,
  step,
  type DataTable,
  type ExecutableFeatureManifest,
  type StepDefinition,
} from "../support/manifest.ts";

/** How the fake Pearl Abyss behind every coordinator answers. */
type PearlAbyssBehaviour = "answers" | "eu-answers-na-unreadable";

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
  /** The gateway's Envelop plugins; absent runs the gateway's own. */
  plugins?: readonly GatewayPlugin[];
}

const INTERNAL_ERROR_TEXT = "internal plugin detail 7f3a";

const catalog = createCatalogSubgraph();
const EU_HOST = PEARL_ABYSS_REGION_HOSTS.EU;
const NA_HOST = PEARL_ABYSS_REGION_HOSTS.NA;

const SUMMARY_QUERY = `{ market(region: EU) { items(ids: ["10006"]) { basePrice } } }`;

const steps: readonly StepDefinition<MarketErrorSemanticsWorld>[] = [
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

  step("a caller asks the gateway for the EU summary of item 10006", noStepArguments, async (world) => {
    world.answers.push(await ask(world, SUMMARY_QUERY));
  }),
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
  }),
  steps,
};

/** Ask the gateway one query, end to end: the private gateway, its market and catalog subgraphs, and Pearl Abyss. */
async function ask(world: MarketErrorSemanticsWorld, query: string): Promise<Answer> {
  const env: AgrisProxyRuntimeEnv = {
    CATALOG: { fetch: (request) => catalog.fetch(request) },
    MARKET: {
      fetch: async (request, reserveBudget, reserveMarketSummary) =>
        executeMarketSubgraph(request, coordinators(world), reserveBudget, reserveMarketSummary),
    },
    ...(world.plugins === undefined ? {} : { plugins: world.plugins }),
  };
  const response = await handleAgrisProxyRequest(
    new Request("https://agris-proxy.internal/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }),
    env,
    (_cacheKey, props) => executeAgrisProxy(env, props),
  );
  return { status: response.status, headers: response.headers, body: graphqlBody(await response.json()) };
}

function coordinators(world: MarketErrorSemanticsWorld): (hostname: string) => PearlAbyssCoordinatorPort {
  return (hostname) => ({ execute: (request) => pearlAbyss(world, hostname, request) });
}

/** What the fake Pearl Abyss answers, as the coordinator passes it on. */
async function pearlAbyss(world: MarketErrorSemanticsWorld, hostname: string, request: Request): Promise<Response> {
  world.pearlAbyssRequests += 1;
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
