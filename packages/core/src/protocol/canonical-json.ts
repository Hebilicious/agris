import type { JsonObject, JsonValue } from "./types.js";

export interface CanonicalJsonObject {
  readonly value: JsonObject;
  readonly text: string;
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ export function canonicalizeJsonObject(
  value: unknown,
): CanonicalJsonObject {
  if (!isRecord(value)) throw new TypeError("GraphQL variables must be a JSON object");
  const canonical = canonicalizeRecord(value);
  return { value: canonical, text: JSON.stringify(canonical) };
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function canonicalizeRecord(
  value: Readonly<Record<string, unknown>>,
): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(result, key, {
      value: canonicalizeValue(value[key]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function canonicalizeValue(
  value: unknown,
): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("GraphQL variables must contain only finite JSON numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalizeValue(entry));
  if (isRecord(value)) return canonicalizeRecord(value);
  throw new TypeError("GraphQL variables must contain only JSON values");
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
