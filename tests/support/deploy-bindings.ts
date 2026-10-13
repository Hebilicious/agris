import { Option, Predicate, Schema } from "effect";

/** A rate limit as a deploy binds it. */
export interface BoundRate {
  readonly limit: number;
  readonly period: number;
}

const decodeRateLimitBinding = Schema.decodeUnknownOption(
  Schema.Struct({ simple: Schema.Struct({ limit: Schema.Number, period: Schema.Number }) }),
);

/** BOUNDARY: The rate a Worker's declared `env` binds under `name`, or `null` when it binds none. */
export function boundRate(env: object, name: string): BoundRate | null {
  const binding: unknown = Predicate.hasProperty(env, name) ? env[name] : undefined;
  if (binding === undefined) return null;
  const { simple } = Option.getOrThrowWith(
    decodeRateLimitBinding(binding),
    () => new TypeError(`${name} is no rate limit`),
  );
  return { limit: simple.limit, period: simple.period };
}

/** The plain-text variables among a Worker's declared `env`. */
export function plainVariables(env: object): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => Predicate.isString(entry[1])),
  );
}
