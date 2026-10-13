import { isInterfaceType, isObjectType, type GraphQLSchema } from "graphql";
import { Exit, Schema, SchemaTransformation } from "effect";

// By package name rather than a relative `.js` path: the site's figure audit loads this file directly in Node, which
// does not map `../freshness.js` to its `.ts` source.
import { MARKET_PRICE_FRESHNESS } from "@agris/core/freshness";

const ONE_DAY_SECONDS = 86_400;

/** How long a stored answer that selects one schema coordinate stays usable. */
export interface CoordinateFreshness {
  /** How long a stored result answers as fresh; `0` stores nothing that selects the coordinate. */
  readonly maxAgeSeconds: number;
  /** How much longer it answers at once while the edge refreshes it in the background. */
  readonly staleWhileRevalidateSeconds: number;
}

/**
 * Everything the gateway needs to choose how long a successful answer may be stored. A response takes the shortest
 * window among the coordinates it selects, then every window is raised to at least `minimumSeconds`.
 */
export interface CacheFreshnessPolicy {
  /** `false` stores nothing: every answer is `no-store`, and no request reaches the edge cache. */
  readonly enabled: boolean;
  /** Freshness windows, keyed by client-schema coordinate (`Type.field`). Unlisted coordinates set no window. */
  readonly coordinates: Readonly<Record<string, CoordinateFreshness>>;
  /** How long a stored answer stays usable while refreshes fail (`stale-if-error`). */
  readonly staleIfErrorSeconds: number;
  /** Coordinates whose answers are never stored: selecting any of them makes the whole response `no-store`. */
  readonly neverStored: readonly string[];
  /** The shortest fresh and stale-while-revalidate window a storable answer gets; `0` sets no floor. */
  readonly minimumSeconds: number;
}

/**
 * A deployment's changes to the default policy. Each field is optional; `coordinates` replaces one window value at a
 * time, the other fields replace the default.
 */
export interface CacheFreshnessOverride {
  readonly enabled?: boolean;
  readonly coordinates?: Readonly<Record<string, Partial<CoordinateFreshness>>>;
  readonly staleIfErrorSeconds?: number;
  readonly neverStored?: readonly string[];
  readonly minimumSeconds?: number;
}

/**
 * The policy a gateway runs with when its deployment sets no `CACHE_*` variable. Market prices follow the end-to-end
 * price policy; everything else stays servable for one more freshness period, at most a day, while it refreshes.
 *
 * Every field that reads Pearl Abyss or the catalog has its own window, so a response always takes the shortest window
 * among what it selects: `Item.marketSummary` takes the price window even under a year-long `Query.items`. The catalog
 * fields (`Query.item`, `Query.items`, `Query.searchItems`) answer from the catalog bundled into this release, and the
 * gateway's cache does not outlive a deploy, so a year is safe. No coordinate is never-stored by default.
 */
export const DEFAULT_CACHE_FRESHNESS: CacheFreshnessPolicy = freezePolicy({
  enabled: true,
  coordinates: {
    "MarketItem.orderBook": { maxAgeSeconds: 5, staleWhileRevalidateSeconds: 5 },
    "Market.registrations": { maxAgeSeconds: 5, staleWhileRevalidateSeconds: 5 },
    "Market.items": MARKET_PRICE_FRESHNESS.edge,
    "Item.marketSummary": MARKET_PRICE_FRESHNESS.edge,
    "MarketItem.listings": MARKET_PRICE_FRESHNESS.edge,
    "Market.catalog": { maxAgeSeconds: 30, staleWhileRevalidateSeconds: 30 },
    "Market.hotItems": { maxAgeSeconds: 30, staleWhileRevalidateSeconds: 30 },
    "MarketItem.priceHistory": { maxAgeSeconds: 3_600, staleWhileRevalidateSeconds: 3_600 },
    "Query.item": { maxAgeSeconds: 31_536_000, staleWhileRevalidateSeconds: ONE_DAY_SECONDS },
    "Query.items": { maxAgeSeconds: 31_536_000, staleWhileRevalidateSeconds: ONE_DAY_SECONDS },
    "Query.searchItems": { maxAgeSeconds: 31_536_000, staleWhileRevalidateSeconds: ONE_DAY_SECONDS },
  },
  staleIfErrorSeconds: ONE_DAY_SECONDS,
  neverStored: [],
  minimumSeconds: 0,
});

/** The default windows by coordinate; `DEFAULT_CACHE_FRESHNESS.coordinates`. */
export const SCHEMA_COORDINATE_FRESHNESS = DEFAULT_CACHE_FRESHNESS.coordinates;

/** The default `stale-if-error` window; `DEFAULT_CACHE_FRESHNESS.staleIfErrorSeconds`. */
export const STALE_IF_ERROR_SECONDS = DEFAULT_CACHE_FRESHNESS.staleIfErrorSeconds;

/** The default never-stored coordinates; `DEFAULT_CACHE_FRESHNESS.neverStored`. */
export const NO_STORE_SCHEMA_COORDINATES: ReadonlySet<string> = new Set(DEFAULT_CACHE_FRESHNESS.neverStored);

/** Apply a typed override to a policy. It does not check coordinates; `cacheFreshnessFromBindings` does. */
export function applyCacheFreshnessOverride(
  base: CacheFreshnessPolicy,
  override: CacheFreshnessOverride,
): CacheFreshnessPolicy {
  const coordinates: Record<string, CoordinateFreshness> = { ...base.coordinates };
  for (const [coordinate, change] of Object.entries(override.coordinates ?? {})) {
    const current = coordinates[coordinate];
    const maxAgeSeconds = change.maxAgeSeconds ?? current?.maxAgeSeconds;
    const staleWhileRevalidateSeconds = change.staleWhileRevalidateSeconds ?? current?.staleWhileRevalidateSeconds;
    if (maxAgeSeconds === undefined || staleWhileRevalidateSeconds === undefined) {
      throw new TypeError(`${coordinate} has no default window, so an override must set both of its values`);
    }
    coordinates[coordinate] = { maxAgeSeconds, staleWhileRevalidateSeconds };
  }
  return freezePolicy({
    enabled: override.enabled ?? base.enabled,
    coordinates,
    staleIfErrorSeconds: override.staleIfErrorSeconds ?? base.staleIfErrorSeconds,
    neverStored: override.neverStored ?? base.neverStored,
    minimumSeconds: override.minimumSeconds ?? base.minimumSeconds,
  });
}

/**
 * The gateway's cache settings, one plain-text variable per value. Every name starts with `CACHE_`; the gateway refuses
 * any other `CACHE_` variable, so a misspelt setting fails instead of being ignored.
 */
export const CACHE_SETTING = Object.freeze({
  /** `true` (the default) or `false`: `false` stores nothing at all. */
  enabled: "CACHE_ENABLED",
  /** Whole seconds a stored answer stays usable while refreshes fail. */
  staleIfErrorSeconds: "CACHE_STALE_IF_ERROR_SECONDS",
  /** Whole seconds every storable answer is kept at least; `0` sets no floor. */
  minimumSeconds: "CACHE_MINIMUM_SECONDS",
  /** Comma-separated coordinates whose answers are never stored; empty stores every coordinate. */
  neverStored: "CACHE_NEVER_STORED",
});

/** The two variables that set one coordinate's window. */
export interface CoordinateCacheSettings {
  readonly coordinate: string;
  /** `CACHE_<TYPE>_<FIELD>_MAX_AGE_SECONDS`. */
  readonly maxAgeSeconds: string;
  /** `CACHE_<TYPE>_<FIELD>_STALE_WHILE_REVALIDATE_SECONDS`. */
  readonly staleWhileRevalidateSeconds: string;
}

/**
 * The variable stem a coordinate's settings share: `Market.items` is `CACHE_MARKET_ITEMS`, `MarketItem.priceHistory`
 * is `CACHE_MARKET_ITEM_PRICE_HISTORY`. Each word boundary of the type and field names becomes an underscore.
 */
export function coordinateSettingStem(coordinate: string): string {
  const snake = (name: string) => name.replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase();
  const [typeName = "", fieldName = ""] = coordinate.split(".");
  return `CACHE_${snake(typeName)}_${snake(fieldName)}`;
}

/** The window settings of every coordinate that has a default window, derived from `DEFAULT_CACHE_FRESHNESS`. */
export const COORDINATE_CACHE_SETTINGS: readonly CoordinateCacheSettings[] = Object.freeze(
  Object.keys(DEFAULT_CACHE_FRESHNESS.coordinates).map((coordinate) => {
    const stem = coordinateSettingStem(coordinate);
    return Object.freeze({
      coordinate,
      maxAgeSeconds: `${stem}_MAX_AGE_SECONDS`,
      staleWhileRevalidateSeconds: `${stem}_STALE_WHILE_REVALIDATE_SECONDS`,
    });
  }),
);

/** Every cache setting the gateway accepts. */
export const CACHE_SETTING_NAMES: readonly string[] = Object.freeze([
  ...Object.values(CACHE_SETTING),
  ...COORDINATE_CACHE_SETTINGS.flatMap((settings) => [settings.maxAgeSeconds, settings.staleWhileRevalidateSeconds]),
]);
if (new Set(CACHE_SETTING_NAMES).size !== CACHE_SETTING_NAMES.length) {
  throw new Error("Two cache settings share a variable name; rename a coordinate or a setting");
}

/** Bindings whose names start with `CACHE_` but that are not cache settings. */
const OTHER_CACHE_PREFIXED_BINDINGS: ReadonlySet<string> = new Set(["CACHE_SMOKE_MODE"]);
const KNOWN_CACHE_SETTINGS: ReadonlySet<string> = new Set(CACHE_SETTING_NAMES);

/** A whole number of seconds, written as digits or bound as a JSON number. */
const WholeSeconds = Schema.Union([
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u)).pipe(
    Schema.decodeTo(Schema.Int, SchemaTransformation.numberFromString),
  ),
]);
const Switch = Schema.Union([
  Schema.Boolean,
  Schema.Literals(["true", "false"]).pipe(
    Schema.decodeTo(
      Schema.Boolean,
      SchemaTransformation.transform({
        decode: (text) => text === "true",
        encode: (value) => (value ? "true" : "false"),
      }),
    ),
  ),
]);
const decodeWholeSeconds = Schema.decodeUnknownExit(WholeSeconds);
const decodeSwitch = Schema.decodeUnknownExit(Switch);

/**
 * BOUNDARY: The cache settings among a gateway's bindings, as a change to the default policy; `undefined` when the
 * bindings set none. Every number must be a non-negative whole number of seconds, every never-stored coordinate a field
 * of `schema`, and every `CACHE_` binding a setting this gateway knows; otherwise it throws a `TypeError` naming each
 * problem, so a bad configuration fails instead of being ignored.
 */
export function cacheFreshnessOverrideFromBindings(
  bindings: object,
  schema: GraphQLSchema,
): CacheFreshnessOverride | undefined {
  const settings = new Map<string, unknown>();
  const problems: string[] = [];
  for (const [name, value] of Object.entries(bindings)) {
    if (!name.startsWith("CACHE_") || OTHER_CACHE_PREFIXED_BINDINGS.has(name)) continue;
    if (KNOWN_CACHE_SETTINGS.has(name)) settings.set(name, value);
    else problems.push(`${name} is not a cache setting`);
  }
  if (settings.size === 0 && problems.length === 0) return undefined;

  const seconds = (name: string): number | undefined => {
    if (!settings.has(name)) return undefined;
    const decoded = decodeWholeSeconds(settings.get(name));
    if (Exit.isSuccess(decoded)) return decoded.value;
    problems.push(`${name} must be a non-negative whole number of seconds`);
    return undefined;
  };

  let enabled: boolean | undefined;
  if (settings.has(CACHE_SETTING.enabled)) {
    const decoded = decodeSwitch(settings.get(CACHE_SETTING.enabled));
    if (Exit.isSuccess(decoded)) enabled = decoded.value;
    else problems.push(`${CACHE_SETTING.enabled} must be "true" or "false"`);
  }

  const coordinates: Record<string, Partial<CoordinateFreshness>> = {};
  for (const setting of COORDINATE_CACHE_SETTINGS) {
    const maxAgeSeconds = seconds(setting.maxAgeSeconds);
    const staleWhileRevalidateSeconds = seconds(setting.staleWhileRevalidateSeconds);
    if (maxAgeSeconds === undefined && staleWhileRevalidateSeconds === undefined) continue;
    coordinates[setting.coordinate] = {
      ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
      ...(staleWhileRevalidateSeconds === undefined ? {} : { staleWhileRevalidateSeconds }),
    };
  }

  let neverStored: readonly string[] | undefined;
  if (settings.has(CACHE_SETTING.neverStored)) {
    const value = settings.get(CACHE_SETTING.neverStored);
    if (typeof value === "string") {
      neverStored = value
        .split(",")
        .map((coordinate) => coordinate.trim())
        .filter((coordinate) => coordinate !== "");
      const unknown = neverStored.filter((coordinate) => !isSchemaFieldCoordinate(schema, coordinate));
      if (unknown.length > 0) {
        problems.push(
          `${CACHE_SETTING.neverStored} names coordinates that are not schema fields: ${unknown.join(", ")}`,
        );
      }
    } else {
      problems.push(`${CACHE_SETTING.neverStored} must be comma-separated text`);
    }
  }

  const staleIfErrorSeconds = seconds(CACHE_SETTING.staleIfErrorSeconds);
  const minimumSeconds = seconds(CACHE_SETTING.minimumSeconds);
  if (problems.length > 0) throw new TypeError(`The gateway's cache settings are invalid: ${problems.join("; ")}`);
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(Object.keys(coordinates).length === 0 ? {} : { coordinates }),
    ...(staleIfErrorSeconds === undefined ? {} : { staleIfErrorSeconds }),
    ...(neverStored === undefined ? {} : { neverStored }),
    ...(minimumSeconds === undefined ? {} : { minimumSeconds }),
  };
}

/**
 * BOUNDARY: The policy a gateway's bindings select: its `CACHE_*` settings applied to `DEFAULT_CACHE_FRESHNESS`, which
 * is returned unchanged when the bindings set none. It throws on the same bindings
 * `cacheFreshnessOverrideFromBindings` refuses.
 */
export function cacheFreshnessFromBindings(bindings: object, schema: GraphQLSchema): CacheFreshnessPolicy {
  const override = cacheFreshnessOverrideFromBindings(bindings, schema);
  return override === undefined
    ? DEFAULT_CACHE_FRESHNESS
    : applyCacheFreshnessOverride(DEFAULT_CACHE_FRESHNESS, override);
}

/** The `CACHE_*` variables that express an override, as plain text: the inverse of `cacheFreshnessOverrideFromBindings`. */
export function cacheSettingsOf(override: CacheFreshnessOverride): Readonly<Record<string, string>> {
  const settings: Record<string, string> = {};
  if (override.enabled !== undefined) settings[CACHE_SETTING.enabled] = String(override.enabled);
  for (const [coordinate, change] of Object.entries(override.coordinates ?? {})) {
    const names = COORDINATE_CACHE_SETTINGS.find((setting) => setting.coordinate === coordinate);
    if (names === undefined) throw new TypeError(`${coordinate} has no cache settings; only defaulted coordinates do`);
    if (change.maxAgeSeconds !== undefined) settings[names.maxAgeSeconds] = String(change.maxAgeSeconds);
    if (change.staleWhileRevalidateSeconds !== undefined) {
      settings[names.staleWhileRevalidateSeconds] = String(change.staleWhileRevalidateSeconds);
    }
  }
  if (override.staleIfErrorSeconds !== undefined) {
    settings[CACHE_SETTING.staleIfErrorSeconds] = String(override.staleIfErrorSeconds);
  }
  if (override.neverStored !== undefined) settings[CACHE_SETTING.neverStored] = override.neverStored.join(",");
  if (override.minimumSeconds !== undefined) settings[CACHE_SETTING.minimumSeconds] = String(override.minimumSeconds);
  return settings;
}

function isSchemaFieldCoordinate(schema: GraphQLSchema, coordinate: string): boolean {
  const match = /^([_A-Za-z][_0-9A-Za-z]*)\.([_A-Za-z][_0-9A-Za-z]*)$/u.exec(coordinate);
  if (match === null) return false;
  const [, typeName = "", fieldName = ""] = match;
  const type = schema.getType(typeName);
  if (!isObjectType(type) && !isInterfaceType(type)) return false;
  return Object.hasOwn(type.getFields(), fieldName);
}

function freezePolicy(policy: CacheFreshnessPolicy): CacheFreshnessPolicy {
  const coordinates: Record<string, CoordinateFreshness> = {};
  for (const [coordinate, freshness] of Object.entries(policy.coordinates)) {
    coordinates[coordinate] = Object.freeze({
      maxAgeSeconds: freshness.maxAgeSeconds,
      staleWhileRevalidateSeconds: freshness.staleWhileRevalidateSeconds,
    });
  }
  return Object.freeze({
    enabled: policy.enabled,
    coordinates: Object.freeze(coordinates),
    staleIfErrorSeconds: policy.staleIfErrorSeconds,
    neverStored: Object.freeze([...policy.neverStored]),
    minimumSeconds: policy.minimumSeconds,
  });
}
