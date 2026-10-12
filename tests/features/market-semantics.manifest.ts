import assert from "node:assert/strict";

import { safeInteger } from "../../packages/market-subgraph/src/market-semantics.ts";
import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";

type MarketSemanticsWorld = Record<string, never>;

const steps: readonly StepDefinition<MarketSemanticsWorld>[] = [
  step("SafeInteger accepts zero and the maximum safe integer", noStepArguments, () => {
    assert.equal(safeInteger(0), 0);
    assert.equal(safeInteger(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  }),
  step("SafeInteger rejects negative, fractional, unsafe, and non-finite numbers", noStepArguments, () => {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN]) {
      assert.throws(() => safeInteger(value), TypeError);
    }
  }),
];

export const marketSemanticsFeature: ExecutableFeatureManifest<MarketSemanticsWorld> = {
  id: "market-semantics",
  uri: "tests/features/market-semantics.feature",
  createWorld: () => ({}),
  steps,
};
