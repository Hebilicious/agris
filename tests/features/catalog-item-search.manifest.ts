import assert from "node:assert/strict";

import {
  createCatalogSubgraph,
  type CatalogSearchTelemetryEvent,
  type CatalogSubgraphRuntime,
} from "../../packages/catalog-subgraph/src/index.ts";
import {
  noStepArguments,
  step,
  stringIntegerStepArguments,
  stringStepArgument,
  type ExecutableFeatureManifest,
  type StepDefinition,
} from "../support/manifest.ts";

interface CatalogItemSearchWorld {
  readonly catalog: CatalogSubgraphRuntime;
  response?: GraphqlResponse;
}

interface GraphqlResponse {
  readonly body: unknown;
  readonly status: number;
}

interface ItemSearchResponseSummary {
  readonly itemCount: number;
  readonly totalCount: number;
}

const steps: readonly StepDefinition<CatalogItemSearchWorld>[] = [
  step(
    "Catalog searches English Item Names for {string} with first {int}",
    stringIntegerStepArguments,
    async (world, query, first) => {
      world.response = await graphqlResponse(
        world.catalog.fetch,
        `query DirectItemSearch($query: String!, $first: Int!) {
          searchItems(query: $query, locale: EN, first: $first) {
            items { id locale name grade }
            totalCount
          }
        }`,
        { query, first },
      );
    },
  ),
  step("it returns Black Stone before Black Stone Powder and reports 4 total matches", noStepArguments, (world) => {
    assert.deepEqual(world.response, {
      status: 200,
      body: {
        data: {
          searchItems: {
            items: [
              { id: "16001", locale: "EN", name: "Black Stone", grade: 4 },
              { id: "4901", locale: "EN", name: "Black Stone Powder", grade: 0 },
            ],
            totalCount: 4,
          },
        },
      },
    });
  }),
  step("Catalog searches English Item Names for {string} without first", stringStepArgument, async (world, query) => {
    world.response = await graphqlResponse(
      world.catalog.fetch,
      `query DefaultItemSearch($query: String!) {
          searchItems(query: $query, locale: EN) { items { id } totalCount }
        }`,
      { query },
    );
  }),
  step("it returns the default 50 Items and reports 166 total matches", noStepArguments, (world) => {
    const search = responseSearchSummary(world.response);
    assert.equal(search.totalCount, 166);
    assert.equal(search.itemCount, 50);
  }),
  step("Catalog searches with a punctuation-only query", noStepArguments, async (world) => {
    world.response = await graphqlResponse(
      world.catalog.fetch,
      `query InvalidSearchQuery {
        searchItems(query: "...", locale: EN) { items { id } totalCount }
      }`,
    );
  }),
  step("Catalog searches with first 101", noStepArguments, async (world) => {
    world.response = await graphqlResponse(
      world.catalog.fetch,
      `query InvalidSearchFirst {
        searchItems(query: "blackstone", locale: EN, first: 101) { items { id } totalCount }
      }`,
    );
  }),
  step("the Catalog response is BAD_USER_INPUT with no partial data", noStepArguments, (world) => {
    assert.equal(world.response?.status, 200);
    const body = requiredRecord(world.response?.body);
    assert.equal(body.data, null);
    assert.ok(Array.isArray(body.errors));
    assert.equal(body.errors.length, 1);
    const error = requiredRecord(body.errors[0]);
    const extensions = requiredRecord(error.extensions);
    assert.equal(extensions.code, "BAD_USER_INPUT");
  }),
];

export const catalogItemSearchFeature: ExecutableFeatureManifest<CatalogItemSearchWorld> = {
  id: "central-market-catalog-item-search",
  uri: "tests/features/catalog-item-search.feature",
  createWorld: () => {
    const telemetry: CatalogSearchTelemetryEvent[] = [];
    let monotonicMilliseconds = 0;
    const catalog = createCatalogSubgraph({
      searchTelemetry: { record: (event) => telemetry.push(event) },
      searchClock: {
        nowMilliseconds: () => {
          const current = monotonicMilliseconds;
          monotonicMilliseconds += 0.2;
          return current;
        },
      },
    });
    return { catalog, telemetry };
  },
  steps,
};

async function graphqlResponse(
  fetch: (request: Request) => Promise<Response>,
  query: string,
  variables?: Readonly<Record<string, string | number>>,
): Promise<GraphqlResponse> {
  const response = await fetch(
    new Request("https://catalog-subgraph.internal/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function responseSearchSummary(
  response: GraphqlResponse | undefined,
): ItemSearchResponseSummary {
  const body = requiredRecord(response?.body);
  const data = requiredRecord(body.data);
  const search = requiredRecord(data.searchItems);
  assert.ok(Array.isArray(search.items));
  const totalCount = search.totalCount;
  assert.ok(typeof totalCount === "number");
  return { itemCount: search.items.length, totalCount };
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function requiredRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  // SAFETY: The assertions above establish the read-only record shape used by integration assertions.
  return value as Readonly<Record<string, unknown>>;
}
