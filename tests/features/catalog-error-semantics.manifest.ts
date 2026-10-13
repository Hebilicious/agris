import assert from "node:assert/strict";

import { createCatalogSubgraph, type CatalogSubgraphRuntime } from "../../packages/catalog-subgraph/src/index.ts";
import type { CatalogItemNameSearch } from "../../packages/catalog-subgraph/src/item-name-search.ts";
import {
  dataTableStepArgument,
  noStepArguments,
  step,
  stringStepArgument,
  type ExecutableFeatureManifest,
  type StepDefinition,
} from "../support/manifest.ts";

const OUT_OF_RANGE_POSITION = 987_654_321;
const INTERNAL_ERROR_MESSAGE = "The catalog subgraph could not answer this field.";

interface CatalogErrorSemanticsWorld {
  catalog: CatalogSubgraphRuntime;
  readonly answers: Answer[];
  /** Each data-table row's expected message prefix, in the order of `answers`. */
  readonly expectations: string[];
}

interface Answer {
  readonly status: number;
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

/** A search that names a position the bundled artifact does not hold, as a corrupt artifact would. */
const outOfRangeSearch: CatalogItemNameSearch = {
  search: () => ({ ok: true, itemPositions: [OUT_OF_RANGE_POSITION], totalCount: 1 }),
  searchWithMetrics: () => ({
    result: { ok: true, itemPositions: [OUT_OF_RANGE_POSITION], totalCount: 1 },
    foldedQueryLength: 10,
    candidateCount: 1,
  }),
};

const steps: readonly StepDefinition<CatalogErrorSemanticsWorld>[] = [
  step("the catalog's item-name search returns a position outside the bundled artifact", noStepArguments, (world) => {
    world.catalog = createCatalogSubgraph({ itemNameSearch: outOfRangeSearch, searchTelemetry: { record: () => {} } });
  }),
  step("a caller asks the catalog subgraph for each of these", dataTableStepArgument, async (world, table) => {
    for (const row of table.hashes) {
      const query = row.query;
      const expected = row["message starts with"];
      assert.ok(query !== undefined && expected !== undefined, "each row needs a query and a message");
      world.answers.push(await ask(world, query));
      world.expectations.push(expected);
    }
  }),
  step(
    "a caller asks the catalog subgraph to search English item names for {string}",
    stringStepArgument,
    async (world, query) => {
      world.answers.push(
        await ask(world, `{ searchItems(query: ${JSON.stringify(query)}, locale: EN) { items { name } totalCount } }`),
      );
    },
  ),
  step(
    "each answer is 200 with one BAD_USER_INPUT error whose message starts with its text",
    noStepArguments,
    (world) => {
      assert.equal(world.answers.length, world.expectations.length);
      world.answers.forEach((answer, index) => {
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        const errors = answer.body.errors ?? [];
        assert.equal(errors.length, 1, JSON.stringify(answer.body));
        const error = errors[0];
        assert.equal(error?.extensions?.code, "BAD_USER_INPUT", JSON.stringify(error));
        assert.ok(error.message.startsWith(world.expectations[index] ?? ""), JSON.stringify(error));
      });
    },
  ),
  step(
    "the answer is 200 with one INTERNAL_SERVER_ERROR at searchItems.items and the fixed catalog message",
    noStepArguments,
    (world) => {
      const answer = onlyAnswer(world);
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      assert.deepEqual(
        answer.body.errors?.map((error) => [error.extensions?.code, error.path, error.message]),
        [["INTERNAL_SERVER_ERROR", ["searchItems", "items"], INTERNAL_ERROR_MESSAGE]],
      );
    },
  ),
  step("no error mentions the bundled artifact or the item position", noStepArguments, (world) => {
    const text = JSON.stringify(onlyAnswer(world).body);
    assert.doesNotMatch(text, /artifact|position|stack|RangeError/iu);
    assert.ok(!text.includes(String(OUT_OF_RANGE_POSITION)), text);
  }),
];

export const catalogErrorSemanticsFeature: ExecutableFeatureManifest<CatalogErrorSemanticsWorld> = {
  id: "catalog-error-semantics",
  uri: "tests/features/catalog-error-semantics.feature",
  createWorld: () => ({
    catalog: createCatalogSubgraph({ searchTelemetry: { record: () => {} } }),
    answers: [],
    expectations: [],
  }),
  steps,
};

async function ask(world: CatalogErrorSemanticsWorld, query: string): Promise<Answer> {
  const response = await world.catalog.fetch(
    new Request("https://catalog-subgraph.internal/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }),
  );
  return { status: response.status, body: graphqlBody(await response.json()) };
}

function onlyAnswer(world: CatalogErrorSemanticsWorld): Answer {
  assert.equal(world.answers.length, 1);
  const answer = world.answers[0];
  assert.ok(answer !== undefined);
  return answer;
}

/* BOUNDARY: The subgraph's answer is JSON; this test reads only the GraphQL response fields it asserts on. */
function graphqlBody(value: unknown): GraphqlBody {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), "the answer is a JSON object");
  // SAFETY: The assertions that read this body compare it against literal expectations, which fail on any other shape.
  return value as GraphqlBody;
}
