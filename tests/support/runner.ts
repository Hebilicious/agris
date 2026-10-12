import {
  CucumberExpression,
  ParameterTypeRegistry,
  RegularExpression,
  type Expression,
} from "@cucumber/cucumber-expressions";
import { generateMessages } from "@cucumber/gherkin";
import {
  IdGenerator,
  SourceMediaType,
  TestStepResultStatus,
  type Envelope,
  type GherkinDocument,
  type Location,
  type Pickle,
  type PickleStep,
} from "@cucumber/messages";
import { parse as parseTagExpression } from "@cucumber/tag-expressions";
import type { DataTable, ExecutableFeatureManifest, SourceLocation, StepDefinition } from "./manifest.ts";
import { Effect, Exit, Scope } from "effect";

export interface StepExecutionResult {
  readonly name: string;
  readonly location?: SourceLocation;
  readonly status: TestStepResultStatus;
  readonly duration: number;
  readonly message?: string;
}

export interface ScenarioExecutionResult {
  readonly id: string;
  readonly uri: string;
  readonly location: SourceLocation;
  readonly name: string;
  readonly status: TestStepResultStatus;
  readonly duration: number;
  readonly steps: readonly StepExecutionResult[];
}

export function assertValidScenarioResult(result: ScenarioExecutionResult): void {
  if (!Number.isFinite(result.duration) || result.duration < 0) {
    throw new Error(`Scenario duration must be finite and non-negative: ${result.duration}`);
  }
  for (const step_ of result.steps) {
    if (!Number.isFinite(step_.duration) || step_.duration < 0) {
      throw new Error(`Step duration must be finite and non-negative: ${step_.duration}`);
    }
  }
}

export interface ParsedFeature {
  readonly pickles: readonly Pickle[];
  readonly astNodeLocations: ReadonlyMap<string, SourceLocation>;
}

export interface LoadedScenario {
  readonly id: string;
  readonly pickle: Pickle;
  readonly astNodeLocations: ReadonlyMap<string, SourceLocation>;
}

export interface FeatureSelection {
  readonly scenarioIds?: readonly string[];
  readonly tagExpression?: string;
}

export class PendingStepError extends Error {
  public constructor(message = "Step is pending") {
    super(message);
    this.name = "PendingStepError";
  }
}

export class SkippedStepError extends Error {
  public constructor(message = "Step was skipped") {
    super(message);
    this.name = "SkippedStepError";
  }
}

export function pending(message?: string): never {
  throw new PendingStepError(message);
}

export function skipped(message?: string): never {
  throw new SkippedStepError(message);
}

function parseErrorMessage(envelopes: readonly Envelope[]): string | undefined {
  const messages = envelopes.flatMap((envelope) =>
    envelope.parseError === undefined ? [] : [envelope.parseError.message],
  );
  return messages.length === 0 ? undefined : messages.join("\n");
}

export function parseFeature(source: string, uri: string): ParsedFeature {
  const envelopes = generateMessages(source, uri, SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN, {
    includeSource: true,
    includeGherkinDocument: true,
    includePickles: true,
    newId: IdGenerator.incrementing(),
  });
  const error = parseErrorMessage(envelopes);
  if (error !== undefined) throw new Error(error);
  return {
    pickles: envelopes.flatMap((envelope) => (envelope.pickle === undefined ? [] : [envelope.pickle])),
    astNodeLocations: collectAstNodeLocations(
      envelopes.flatMap((envelope) => (envelope.gherkinDocument === undefined ? [] : [envelope.gherkinDocument])),
    ),
  };
}

function collectAstNodeLocations(documents: readonly GherkinDocument[]): ReadonlyMap<string, SourceLocation> {
  const locations = new Map<string, SourceLocation>();
  function recordScenario(
    scenario: NonNullable<NonNullable<GherkinDocument["feature"]>["children"][number]["scenario"]>,
  ): void {
    locations.set(scenario.id, sourceLocation(scenario.location));
    for (const step_ of scenario.steps) locations.set(step_.id, sourceLocation(step_.location));
    for (const examples of scenario.examples) {
      locations.set(examples.id, sourceLocation(examples.location));
      if (examples.tableHeader !== undefined) {
        locations.set(examples.tableHeader.id, sourceLocation(examples.tableHeader.location));
      }
      for (const row of examples.tableBody) locations.set(row.id, sourceLocation(row.location));
    }
  }
  for (const document of documents) {
    for (const child of document.feature?.children ?? []) {
      for (const step_ of child.background?.steps ?? []) {
        locations.set(step_.id, sourceLocation(step_.location));
      }
      if (child.scenario !== undefined) recordScenario(child.scenario);
      for (const ruleChild of child.rule?.children ?? []) {
        for (const step_ of ruleChild.background?.steps ?? []) {
          locations.set(step_.id, sourceLocation(step_.location));
        }
        if (ruleChild.scenario !== undefined) recordScenario(ruleChild.scenario);
      }
    }
  }
  return locations;
}

function sourceLocation(location: Location | undefined): SourceLocation {
  if (location === undefined) throw new Error("Cucumber did not provide a Scenario source location");
  return { line: location.line, column: location.column ?? 1 };
}

export function stableScenarioTagId(pickle: Pickle): string {
  const idTags = pickle.tags.filter((tag) => tag.name.startsWith("@scenario:"));
  if (idTags.length !== 1) {
    throw new Error(
      `Scenario "${pickle.name}" in ${pickle.uri}:${pickle.location?.line ?? "?"} must have exactly one @scenario:<id> tag`,
    );
  }
  const localId = idTags[0]?.name.slice("@scenario:".length);
  if (localId === undefined || localId.length === 0)
    throw new Error(`Scenario "${pickle.name}" has an empty stable id`);
  return localId;
}

export function stableScenarioPrefix(featureId: string, pickle: Pickle): string {
  return `${featureId}/${stableScenarioTagId(pickle)}`;
}

function validateManifest<World>(
  manifest: ExecutableFeatureManifest<World>,
  pickles: readonly Pickle[],
): Map<string, Pickle> {
  const byId = new Map<string, Pickle>();
  for (const pickle of pickles) {
    const id = stableScenarioPrefix(manifest.id, pickle);
    if (byId.has(id)) throw new Error(`Stable Scenario id "${id}" identifies more than one Pickle`);
    byId.set(id, pickle);
  }
  return byId;
}

function makeExpression(pattern: string | RegExp, registry: ParameterTypeRegistry): Expression {
  return pattern instanceof RegExp
    ? new RegularExpression(pattern, registry)
    : new CucumberExpression(pattern, registry);
}

interface MatchedStep<World> {
  readonly definition: StepDefinition<World>;
  readonly values: readonly unknown[];
}

function tableArgument(step: PickleStep): DataTable | string | undefined {
  if (step.argument?.docString !== undefined) return step.argument.docString.content;
  const rows = step.argument?.dataTable?.rows.map((row) => row.cells.map((cell) => cell.value));
  if (rows === undefined) return undefined;
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  return {
    raw: rows,
    rows: body,
    hashes: body.map((row) => Object.fromEntries(header.map((name, index) => [name, row[index] ?? ""]))),
  };
}

function matchStep<World>(
  step: PickleStep,
  definitions: readonly StepDefinition<World>[],
  registry: ParameterTypeRegistry,
): readonly MatchedStep<World>[] {
  return definitions.flatMap((definition) => {
    const match = makeExpression(definition.pattern, registry).match(step.text);
    if (match === null) return [];
    const values: unknown[] = match.map((argument) => argument.getValue(undefined));
    const argument = tableArgument(step);
    if (argument !== undefined) values.push(argument);
    return [{ definition, values }];
  });
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function errorMessage(
  error: unknown,
): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function scenarioStatus(steps: readonly StepExecutionResult[]): TestStepResultStatus {
  const severity = {
    [TestStepResultStatus.UNKNOWN]: 1,
    [TestStepResultStatus.PASSED]: 0,
    [TestStepResultStatus.SKIPPED]: 2,
    [TestStepResultStatus.PENDING]: 3,
    [TestStepResultStatus.UNDEFINED]: 4,
    [TestStepResultStatus.AMBIGUOUS]: 5,
    [TestStepResultStatus.FAILED]: 6,
  } satisfies Readonly<Record<TestStepResultStatus, number>>;
  return steps.reduce<TestStepResultStatus>(
    (worst, step) => (severity[step.status] > severity[worst] ? step.status : worst),
    TestStepResultStatus.PASSED,
  );
}

// The harness clock is bound once, at module load. Fake timers replace the ambient `performance`
// object, so an ambient read inside a scenario measures the test's simulated clock and reports a
// negative duration to `assertValidScenarioResult`.
const harnessClock = performance.now.bind(performance);

export async function executeScenario<World>(
  manifest: ExecutableFeatureManifest<World>,
  pickle: Pickle,
  astNodeLocations: ReadonlyMap<string, SourceLocation> = new Map(),
): Promise<ScenarioExecutionResult> {
  const started = harnessClock();
  const id = stableScenarioPrefix(manifest.id, pickle);
  const location = sourceLocation(pickle.location);
  const world = manifest.createWorld({ id, uri: pickle.uri, location, name: pickle.name });
  const scenario = Effect.runSync(Scope.make());
  const results: StepExecutionResult[] = [];
  try {
    const registry = new ParameterTypeRegistry();
    let blocked = false;
    for (const pickleStep of pickle.steps) {
      const stepStarted = harnessClock();
      const location = pickleStep.astNodeIds
        .map((id) => astNodeLocations.get(id))
        .find((candidate) => candidate !== undefined);
      const located = location === undefined ? {} : { location };
      if (blocked) {
        results.push({
          name: pickleStep.text,
          ...located,
          status: TestStepResultStatus.SKIPPED,
          duration: harnessClock() - stepStarted,
        });
        continue;
      }
      const matches = matchStep(pickleStep, manifest.steps, registry);
      if (matches.length === 0) {
        results.push({
          name: pickleStep.text,
          ...located,
          status: TestStepResultStatus.UNDEFINED,
          duration: harnessClock() - stepStarted,
          message: `Undefined step: ${pickleStep.text}`,
        });
        blocked = true;
        continue;
      }
      if (matches.length > 1) {
        results.push({
          name: pickleStep.text,
          ...located,
          status: TestStepResultStatus.AMBIGUOUS,
          duration: harnessClock() - stepStarted,
          message: `Ambiguous step: ${pickleStep.text}`,
        });
        blocked = true;
        continue;
      }
      const match = matches[0];
      if (match === undefined) throw new Error("Matched step disappeared");
      try {
        await match.definition.execute(world, match.values, scenario);
        results.push({
          name: pickleStep.text,
          ...located,
          status: TestStepResultStatus.PASSED,
          duration: harnessClock() - stepStarted,
        });
      } catch (error) {
        const status =
          error instanceof PendingStepError
            ? TestStepResultStatus.PENDING
            : error instanceof SkippedStepError
              ? TestStepResultStatus.SKIPPED
              : TestStepResultStatus.FAILED;
        results.push({
          name: pickleStep.text,
          ...located,
          status,
          duration: harnessClock() - stepStarted,
          message: errorMessage(error),
        });
        blocked = true;
      }
    }
  } finally {
    await Effect.runPromise(Scope.close(scenario, Exit.void));
  }
  return {
    id,
    uri: pickle.uri,
    location,
    name: pickle.name,
    status: scenarioStatus(results),
    duration: harnessClock() - started,
    steps: results,
  };
}

export async function loadFeature<World>(
  manifest: ExecutableFeatureManifest<World>,
  sourceUrl: URL,
): Promise<readonly LoadedScenario[]> {
  // Loaded only by Node runners; Browser evidence passes its Feature source directly.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(sourceUrl, "utf8");
  return loadFeatureSource(manifest, source);
}

export function loadFeatureSource<World>(
  manifest: ExecutableFeatureManifest<World>,
  source: string,
): readonly LoadedScenario[] {
  const parsed = parseFeature(source, manifest.uri);
  return [...validateManifest(manifest, parsed.pickles)].map(([id, pickle]) => ({
    id,
    pickle,
    astNodeLocations: parsed.astNodeLocations,
  }));
}

export function selectScenarios<World>(
  manifest: ExecutableFeatureManifest<World>,
  scenarios: readonly LoadedScenario[],
  selection: FeatureSelection = {},
): readonly LoadedScenario[] {
  const ids = selection.scenarioIds === undefined ? undefined : new Set(selection.scenarioIds);
  const tagNode = selection.tagExpression === undefined ? undefined : parseTagExpression(selection.tagExpression);
  const selected = scenarios.filter(({ id, pickle }) => {
    if (ids !== undefined && !ids.has(id)) return false;
    return tagNode?.evaluate(pickle.tags.map((tag) => tag.name)) ?? true;
  });
  if (ids !== undefined) {
    const missing = [...ids].filter((id) => !scenarios.some((scenario) => scenario.id === id));
    if (missing.length > 0) throw new Error(`Unknown Scenario ids for ${manifest.id}: ${missing.join(", ")}`);
  }
  return selected;
}

export function formatNonGreenResult(result: ScenarioExecutionResult): string {
  const details = result.steps
    .filter((step) => step.status !== TestStepResultStatus.PASSED)
    .map((step) => `${step.status} ${step.name}${step.message === undefined ? "" : ` — ${step.message}`}`)
    .join("\n");
  return `${result.status} ${result.id} at ${result.uri}:${result.location.line}:${result.location.column}\n${details}`;
}
