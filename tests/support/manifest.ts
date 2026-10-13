import { Effect, Scope } from "effect";

export interface ExecutableNativeProperty {
  readonly id: string;
  readonly testName: string;
  readonly execute: () => void | Promise<void>;
}

export interface SourceLocation {
  readonly line: number;
  readonly column: number;
}

export interface ScenarioContext {
  readonly id: string;
  readonly uri: string;
  readonly location: SourceLocation;
  readonly name: string;
}

export interface DataTable {
  readonly raw: readonly (readonly string[])[];
  readonly rows: readonly (readonly string[])[];
  readonly hashes: readonly Readonly<Record<string, string>>[];
}

export type StepPattern = string | RegExp;

export interface StepDefinition<World> {
  readonly pattern: StepPattern;
  /** `scenario` is the scenario's Scope: it stays open across steps and closes when the scenario ends. */
  readonly execute: (world: World, arguments_: readonly unknown[], scenario: Scope.Scope) => void | Promise<void>;
}

/**
 * A step returns nothing, a Promise, or an Effect. The runner runs an Effect inside the scenario's Scope, so a step
 * can fork work that a later step joins or interrupts, and register cleanup with `Effect.addFinalizer`.
 */
type StepOutcome<E> = void | Promise<void> | Effect.Effect<void, E, Scope.Scope>;

export type StepArgumentsDecoder<Arguments extends readonly unknown[]> = (arguments_: readonly unknown[]) => Arguments;

export interface ExecutableFeatureManifest<World> {
  readonly id: string;
  readonly uri: string;
  readonly createWorld: (scenario: ScenarioContext) => World;
  readonly steps: readonly StepDefinition<World>[];
}

function requireArgumentCount(arguments_: readonly unknown[], expected: number): void {
  if (arguments_.length !== expected) {
    throw new Error(`Expected ${expected} Gherkin arguments, received ${arguments_.length}`);
  }
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function requireString(
  value: unknown,
  position: number,
): string {
  if (typeof value !== "string") throw new Error(`Expected string Gherkin argument ${position}`);
  return value;
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function requireInteger(
  value: unknown,
  position: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Expected integer Gherkin argument ${position}`);
  }
  return value;
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function requireNumber(
  value: unknown,
  position: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Expected number Gherkin argument ${position}`);
  return value;
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function requireStringRows(
  value: unknown,
  field: string,
): readonly (readonly string[])[] {
  if (!Array.isArray(value)) throw new Error(`Expected DataTable ${field} rows`);
  return value.map((row) => {
    if (!Array.isArray(row) || row.some((cell) => typeof cell !== "string")) {
      throw new Error(`Expected DataTable ${field} to contain only string rows`);
    }
    return row;
  });
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function requireDataTable(
  value: unknown,
): DataTable {
  if (typeof value !== "object" || value === null) throw new Error("Expected DataTable Gherkin argument 1");
  const raw = requireStringRows(Reflect.get(value, "raw"), "raw");
  const rows = requireStringRows(Reflect.get(value, "rows"), "body");
  const importedHashes: unknown = Reflect.get(value, "hashes");
  if (!Array.isArray(importedHashes)) throw new Error("Expected DataTable hashes");
  const hashes = importedHashes.map((hash) => {
    if (typeof hash !== "object" || hash === null || Array.isArray(hash)) {
      throw new Error("Expected each DataTable hash to be a record");
    }
    const normalized: Record<string, string> = {};
    for (const [name, cell] of Object.entries(hash)) {
      if (typeof cell !== "string") {
        throw new Error("Expected DataTable hashes to contain only string values");
      }
      normalized[name] = cell;
    }
    return normalized;
  });
  return { raw, rows, hashes };
}

export const noStepArguments: StepArgumentsDecoder<[]> = (arguments_) => {
  requireArgumentCount(arguments_, 0);
  return [];
};

export const stringStepArgument: StepArgumentsDecoder<[string]> = (arguments_) => {
  requireArgumentCount(arguments_, 1);
  return [requireString(arguments_[0], 1)];
};

export const integerStepArgument: StepArgumentsDecoder<[number]> = (arguments_) => {
  requireArgumentCount(arguments_, 1);
  return [requireInteger(arguments_[0], 1)];
};

export const numberStepArgument: StepArgumentsDecoder<[number]> = (arguments_) => {
  requireArgumentCount(arguments_, 1);
  return [requireNumber(arguments_[0], 1)];
};

export const dataTableStepArgument: StepArgumentsDecoder<[DataTable]> = (arguments_) => {
  requireArgumentCount(arguments_, 1);
  return [requireDataTable(arguments_[0])];
};

export const stringPairStepArguments: StepArgumentsDecoder<[string, string]> = (arguments_) => {
  requireArgumentCount(arguments_, 2);
  return [requireString(arguments_[0], 1), requireString(arguments_[1], 2)];
};

export const stringTripleStepArguments: StepArgumentsDecoder<[string, string, string]> = (arguments_) => {
  requireArgumentCount(arguments_, 3);
  return [requireString(arguments_[0], 1), requireString(arguments_[1], 2), requireString(arguments_[2], 3)];
};

export const stringQuadrupleStepArguments: StepArgumentsDecoder<[string, string, string, string]> = (arguments_) => {
  requireArgumentCount(arguments_, 4);
  return [
    requireString(arguments_[0], 1),
    requireString(arguments_[1], 2),
    requireString(arguments_[2], 3),
    requireString(arguments_[3], 4),
  ];
};

export const integerPairStepArguments: StepArgumentsDecoder<[number, number]> = (arguments_) => {
  requireArgumentCount(arguments_, 2);
  return [requireInteger(arguments_[0], 1), requireInteger(arguments_[1], 2)];
};

export const integerTripleStepArguments: StepArgumentsDecoder<[number, number, number]> = (arguments_) => {
  requireArgumentCount(arguments_, 3);
  return [requireInteger(arguments_[0], 1), requireInteger(arguments_[1], 2), requireInteger(arguments_[2], 3)];
};

export const integerQuadStepArguments: StepArgumentsDecoder<[number, number, number, number]> = (arguments_) => {
  requireArgumentCount(arguments_, 4);
  return [
    requireInteger(arguments_[0], 1),
    requireInteger(arguments_[1], 2),
    requireInteger(arguments_[2], 3),
    requireInteger(arguments_[3], 4),
  ];
};

export const integerStringStepArguments: StepArgumentsDecoder<[number, string]> = (arguments_) => {
  requireArgumentCount(arguments_, 2);
  return [requireInteger(arguments_[0], 1), requireString(arguments_[1], 2)];
};

export const stringIntegerStepArguments: StepArgumentsDecoder<[string, number]> = (arguments_) => {
  requireArgumentCount(arguments_, 2);
  return [requireString(arguments_[0], 1), requireInteger(arguments_[1], 2)];
};

export function step<World, Arguments extends readonly unknown[], E = never>(
  pattern: StepPattern,
  decodeArguments: StepArgumentsDecoder<Arguments>,
  implementation: (world: World, ...arguments_: Arguments) => StepOutcome<E>,
): StepDefinition<World> {
  return {
    pattern,
    // A step that returns nothing or a Promise keeps the exact scheduling it had before steps could return Effects.
    execute: (world, arguments_, scenario) => {
      const outcome = implementation(world, ...decodeArguments(arguments_));
      return Effect.isEffect(outcome) ? Effect.runPromise(outcome.pipe(Scope.provide(scenario))) : outcome;
    },
  };
}
