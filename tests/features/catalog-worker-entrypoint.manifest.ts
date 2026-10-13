import assert from "node:assert/strict";
import { env } from "cloudflare:test";

import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";

interface CatalogWorkerEntrypointWorld {
  response?: Response;
  body?: unknown;
}

const steps: readonly StepDefinition<CatalogWorkerEntrypointWorld>[] = [
  step("item 10006 is requested through the production Catalog Worker entrypoint", noStepArguments, async (world) => {
    const response = await env.CATALOG.fetch(
      new Request("https://central-market-catalog.internal/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: 'query CatalogWorkerItem { item(id: "10006", locale: EN) { id locale name grade } }',
        }),
      }),
    );
    world.response = response;
    world.body = await response.clone().json();
  }),
  step("the Catalog Worker response contains the bundled English metadata", noStepArguments, (world) => {
    assert.equal(world.response?.status, 200);
    assert.deepEqual(world.body, {
      data: {
        item: {
          id: "10006",
          locale: "EN",
          name: "Ain Longsword",
          grade: 1,
        },
      },
    });
  }),
];

export const centralMarketCatalogWorkerEntrypointFeature: ExecutableFeatureManifest<CatalogWorkerEntrypointWorld> = {
  id: "central-market-catalog-worker-entrypoint",
  uri: "tests/features/catalog-worker-entrypoint.feature",
  createWorld: () => ({}),
  steps,
};
