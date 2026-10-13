const persistedOperationIdPattern = /^[0-9a-f]{64}$/u;

export interface CanonicalPersistedGet {
  readonly id: string;
  /* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ readonly variables: Readonly<
    Record<string, unknown>
  >;
}

export type CanonicalPersistedGetResult =
  | { readonly ok: true; readonly value: CanonicalPersistedGet }
  | {
      readonly ok: false;
      readonly error: "invalid-request" | "unknown-persisted-operation" | "invalid-variables";
    };

export function parseCanonicalPersistedGet(searchParams: string): CanonicalPersistedGetResult {
  const parameters = new URLSearchParams(searchParams);
  if ([...parameters.keys()].some((key) => key !== "id" && key !== "variables")) {
    return { ok: false, error: "invalid-request" };
  }

  const ids = parameters.getAll("id");
  const variablesValues = parameters.getAll("variables");
  if (ids.length !== 1 || variablesValues.length !== 1) {
    return { ok: false, error: "invalid-request" };
  }

  const id = ids[0];
  if (id === undefined || !persistedOperationIdPattern.test(id)) {
    return { ok: false, error: "unknown-persisted-operation" };
  }

  let variables: unknown;
  try {
    variables = JSON.parse(variablesValues[0] ?? "");
  } catch {
    return { ok: false, error: "invalid-variables" };
  }
  if (!isRecord(variables)) return { ok: false, error: "invalid-variables" };
  return { ok: true, value: { id, variables } };
}

export function isPersistedOperationId(value: string): boolean {
  return persistedOperationIdPattern.test(value);
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
