import { test } from "vitest";
import { TestStepResultStatus } from "@cucumber/messages";
import { effectTests } from "./effect-test.ts";
import type { ExecutableFeatureManifest } from "./manifest.ts";
import {
  assertValidScenarioResult,
  executeScenario,
  formatNonGreenResult,
  loadFeature,
  loadFeatureSource,
  selectScenarios,
  type FeatureSelection,
} from "./runner.ts";

export interface ScenarioTestRegistrar {
  (name: string, options: { readonly retry: 0 }, execute: () => Promise<void>): void;
}

const registerVitestScenario: ScenarioTestRegistrar = (name, options, execute) => test(name, options, execute);

export async function registerFeature<World>(
  manifest: ExecutableFeatureManifest<World>,
  sourceUrl: URL,
  selection: FeatureSelection = {},
  registerScenarioTest: ScenarioTestRegistrar = registerVitestScenario,
): Promise<void> {
  registerFeatureScenarios(manifest, await loadFeature(manifest, sourceUrl), selection, registerScenarioTest);
}

export function registerFeatureSource<World>(
  manifest: ExecutableFeatureManifest<World>,
  source: string,
  selection: FeatureSelection = {},
  registerScenarioTest: ScenarioTestRegistrar = registerVitestScenario,
): void {
  registerFeatureScenarios(manifest, loadFeatureSource(manifest, source), selection, registerScenarioTest);
}

function registerFeatureScenarios<World>(
  manifest: ExecutableFeatureManifest<World>,
  scenarios: ReturnType<typeof loadFeatureSource<World>>,
  selection: FeatureSelection,
  registerScenarioTest: ScenarioTestRegistrar,
): void {
  const selectedScenarios = selectScenarios(manifest, scenarios, selection);
  for (const { id, pickle, astNodeLocations } of selectedScenarios) {
    registerScenarioTest(`${id}: ${pickle.name}`, { retry: 0 }, async () => {
      const result = await executeScenario(manifest, pickle, astNodeLocations);
      assertValidScenarioResult(result);
      if (result.status !== TestStepResultStatus.PASSED) throw new Error(formatNonGreenResult(result));
    });
  }
}

/** One vitest case whose body is an Effect. */
export const testEffect = effectTests((name, run) => {
  test(name, run);
});
