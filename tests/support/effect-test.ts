import { Effect, type Scope } from "effect";

/**
 * Turns a runner's `test` into one whose case body is an Effect, run in its own Scope, so whatever the case acquires
 * is released when it ends. Each runner adapter exports the result as `testEffect`.
 */
export function effectTests(register: (name: string, run: () => Promise<void>) => void) {
  return <E>(name: string, body: () => Effect.Effect<void, E, Scope.Scope>): void =>
    register(name, () => Effect.runPromise(Effect.scoped(Effect.suspend(body))));
}
