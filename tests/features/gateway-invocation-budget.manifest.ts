import assert from "node:assert/strict";

import { createCatalogSubgraph } from "../../packages/catalog-subgraph/src/index.ts";
import { executeAgrisProxy, type AgrisProxyRuntimeEnv } from "../../apps/gateway/src/gateway.ts";
import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";

interface GatewayInvocationBudgetWorld {
  catalogCalls: number;
  responses?: readonly Response[];
  bodies?: readonly unknown[];
}

const catalog = createCatalogSubgraph();

function runtime(world: GatewayInvocationBudgetWorld, subrequestLimit: number): AgrisProxyRuntimeEnv {
  return {
    CATALOG: {
      fetch: (request) => {
        world.catalogCalls += 1;
        return catalog.fetch(request);
      },
    },
    MARKET: { fetch: () => Promise.reject(new Error("A catalog query never reaches the market")) },
    subrequestLimit,
  };
}

function execute(world: GatewayInvocationBudgetWorld, subrequestLimit: number, name: string): Promise<Response> {
  return executeAgrisProxy(runtime(world, subrequestLimit), {
    cachePolicy: { mode: "no-store" },
    document: `query ${name}{item(id:"44195" locale:EN){name}}`,
    operationName: name,
    variables: {},
    smokeFailureAfterEpochMs: null,
  });
}

async function settle(world: GatewayInvocationBudgetWorld, responses: readonly Response[]): Promise<void> {
  world.responses = responses;
  world.bodies = await Promise.all(responses.map((response) => response.json()));
}

const steps: readonly StepDefinition<GatewayInvocationBudgetWorld>[] = [
  step("a catalog query executes with a subrequest budget of 0", noStepArguments, async (world) => {
    await settle(world, [await execute(world, 0, "Exhausted")]);
  }),
  step("the answer is HTTP 200 with a QUERY_BUDGET_EXCEEDED error and no catalog call", noStepArguments, (world) => {
    assert.equal(world.responses?.[0]?.status, 200);
    assert.match(JSON.stringify(world.bodies?.[0]), /QUERY_BUDGET_EXCEEDED/u);
    assert.equal(world.catalogCalls, 0);
  }),
  step(
    "three catalog queries execute one after another and two at once, each with a subrequest budget of 1",
    noStepArguments,
    async (world) => {
      const sequential = [
        await execute(world, 1, "First"),
        await execute(world, 1, "Second"),
        await execute(world, 1, "Third"),
      ];
      const concurrent = await Promise.all([execute(world, 1, "Fourth"), execute(world, 1, "Fifth")]);
      await settle(world, [...sequential, ...concurrent]);
    },
  ),
  step("every answer has the item's name and the catalog was called five times", noStepArguments, (world) => {
    assert.deepEqual(
      world.responses?.map((response) => response.status),
      [200, 200, 200, 200, 200],
    );
    for (const body of world.bodies ?? []) {
      assert.deepEqual(body, { data: { item: { name: "Memory Fragment" } } });
    }
    assert.equal(world.catalogCalls, 5);
  }),
];

export const gatewayInvocationBudgetFeature: ExecutableFeatureManifest<GatewayInvocationBudgetWorld> = {
  id: "gateway-invocation-budget",
  uri: "tests/features/gateway-invocation-budget.feature",
  createWorld: () => ({ catalogCalls: 0 }),
  steps,
};
