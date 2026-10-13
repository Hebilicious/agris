/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ export function safeInteger(
  value: unknown,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("SafeInteger must be a non-negative safe integer");
  }
  return value;
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ export function dateTime(
  value: unknown,
): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError("DateTime must be an RFC 3339 UTC timestamp");
  }
  const parsed = new Date(value);
  if (
    parsed.getUTCFullYear() !== Number(value.slice(0, 4)) ||
    parsed.getUTCMonth() + 1 !== Number(value.slice(5, 7)) ||
    parsed.getUTCDate() !== Number(value.slice(8, 10)) ||
    parsed.getUTCHours() !== Number(value.slice(11, 13)) ||
    parsed.getUTCMinutes() !== Number(value.slice(14, 16)) ||
    parsed.getUTCSeconds() !== Number(value.slice(17, 19))
  ) {
    throw new TypeError("DateTime must be an RFC 3339 UTC timestamp");
  }
  return value;
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ export function enhancementLevel(
  value: unknown,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 20) {
    throw new TypeError("Enhancement level must be an integer from 0 through 20");
  }
  return value;
}

export function dateTimeFromEpochSeconds(value: number): string | null {
  const timestamp = safeInteger(value);
  if (timestamp === 0) return null;
  const milliseconds = timestamp * 1_000;
  if (!Number.isSafeInteger(milliseconds)) throw new TypeError("Epoch timestamp is outside the safe DateTime range");
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Epoch timestamp is outside the DateTime range");
  return date.toISOString();
}
