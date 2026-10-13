import assert from "node:assert/strict";

import { createCatalogSubgraph } from "../../packages/catalog-subgraph/src/index.ts";
import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";

interface CatalogResolutionWorld {
  directResponse?: CatalogGraphqlResponse;
  listResponse?: CatalogGraphqlResponse;
  repeatedListResponse?: CatalogGraphqlResponse;
}

interface CatalogGraphqlResponse {
  readonly body: unknown;
  readonly status: number;
}

interface CatalogGraphqlVariables {
  readonly representations: readonly {
    readonly __typename: "Item";
    readonly id: string;
    readonly locale: "EN" | "FR";
  }[];
}

const catalog = createCatalogSubgraph();

const steps: readonly StepDefinition<CatalogResolutionWorld>[] = [
  step(
    "the catalog directly resolves item 10006 in English and French and an unknown item",
    noStepArguments,
    async (world) => {
      world.directResponse = await catalogResponse(
        `query DirectCatalogItems {
          english: item(id: "10006", locale: EN) { id locale name grade }
          french: item(id: "10006", locale: FR) { id locale name grade }
          unknown: item(id: "999999999", locale: EN) { id locale name grade }
        }`,
      );
    },
  ),
  step("each supported locale returns its checked-in name and grade", noStepArguments, (world) => {
    assert.equal(world.directResponse?.status, 200);
    assert.deepEqual(world.directResponse?.body, {
      data: {
        english: { id: "10006", locale: "EN", name: "Ain Longsword", grade: 1 },
        french: { id: "10006", locale: "FR", name: "Épée longue d'Ain", grade: 1 },
        unknown: null,
      },
    });
  }),
  step("the unknown direct item is null", noStepArguments, (world) => {
    const body = requiredRecord(world.directResponse?.body);
    const data = requiredRecord(body.data);
    assert.equal(data.unknown, null);
  }),
  step("the catalog resolves items 10007, 999999999, 10006, and 10007 in English", noStepArguments, async (world) => {
    world.listResponse = await catalogResponse(
      `query OrderedCatalogItems {
          items(ids: ["10007", "999999999", "10006", "10007"], locale: EN) {
            id locale name grade
          }
        }`,
    );
  }),
  step("all four item identities remain in caller order with nullable unknown metadata", noStepArguments, (world) => {
    assert.equal(world.listResponse?.status, 200);
    assert.deepEqual(world.listResponse?.body, {
      data: {
        items: [
          { id: "10007", locale: "EN", name: "Seleth Longsword", grade: 1 },
          { id: "999999999", locale: "EN", name: null, grade: null },
          { id: "10006", locale: "EN", name: "Ain Longsword", grade: 1 },
          { id: "10007", locale: "EN", name: "Seleth Longsword", grade: 1 },
        ],
      },
    });
  }),
  step("changing the returned data cannot change a later catalog response", noStepArguments, async (world) => {
    const body = requiredRecord(world.listResponse?.body);
    const data = requiredRecord(body.data);
    assert.ok(Array.isArray(data.items));
    const first = requiredRecord(data.items[0]);
    first.name = "Mutated response";
    world.repeatedListResponse = await catalogResponse(
      `query RepeatedCatalogItem { item(id: "10007", locale: EN) { id locale name grade } }`,
    );
    assert.deepEqual(world.repeatedListResponse, {
      status: 200,
      body: {
        data: { item: { id: "10007", locale: "EN", name: "Seleth Longsword", grade: 1 } },
      },
    });
  }),
];

export const centralMarketCatalogResolutionFeature: ExecutableFeatureManifest<CatalogResolutionWorld> = {
  id: "central-market-catalog-resolution",
  uri: "tests/features/catalog-resolution.feature",
  createWorld: () => ({}),
  steps,
};

async function catalogResponse(query: string, variables?: CatalogGraphqlVariables): Promise<CatalogGraphqlResponse> {
  const response = await catalog.fetch(
    new Request("https://catalog-subgraph.internal/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function requiredRecord(
  value: unknown,
): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  // SAFETY: The assertions above establish the mutable record shape used only for detached-response verification.
  return value as Record<string, unknown>;
}
