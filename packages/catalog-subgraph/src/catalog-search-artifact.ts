import type { PearlAbyssItemLocale } from "@agris/pearl-abyss/locales";

export interface CompactGramIndex {
  readonly grams: PackedStringColumn;
  readonly offsets: ImmutableNumberColumn;
  readonly postings: ImmutableNumberColumn;
}

/** Immutable positional access to a private typed numeric column. */
export interface ImmutableNumberColumn {
  readonly length: number;
  valueAt(position: number): number | undefined;
}

/** Immutable positional access to a packed UTF-16 string column. */
export interface PackedStringColumn {
  readonly length: number;
  valueAt(position: number): string | undefined;
}

/**
 * Retains one string payload and hides a validated defensive copy of its UTF-16 offsets.
 * Invalid positions behave like indexed array reads and return `undefined`.
 */
export function createPackedStringColumn(packed: string, sourceOffsets: Uint32Array): PackedStringColumn {
  if (!(sourceOffsets instanceof Uint32Array) || sourceOffsets.length === 0 || sourceOffsets[0] !== 0) {
    throw new TypeError("Packed string column offsets must be a non-empty Uint32Array starting at zero");
  }
  const offsets = sourceOffsets.slice();
  let previous = 0;
  for (const offset of offsets) {
    if (offset < previous || offset > packed.length) {
      throw new TypeError("Packed string column offsets must be monotonic and within the payload");
    }
    previous = offset;
  }
  if (previous !== packed.length) throw new TypeError("Packed string column offsets must span the payload");

  const length = offsets.length - 1;
  return Object.freeze({
    length,
    valueAt(position: number): string | undefined {
      if (!Number.isSafeInteger(position) || position < 0 || position >= length) return undefined;
      const start = offsets[position];
      const end = offsets[position + 1];
      return start === undefined || end === undefined ? undefined : packed.slice(start, end);
    },
  });
}

/** Retains a defensive copy of a numeric column without exposing its mutable typed array. */
export function createImmutableNumberColumn(sourceValues: Uint32Array | Uint8Array): ImmutableNumberColumn {
  if (!(sourceValues instanceof Uint32Array) && !(sourceValues instanceof Uint8Array)) {
    throw new TypeError("Immutable number column source must be a Uint32Array or Uint8Array");
  }
  const values = sourceValues.slice();
  return Object.freeze({
    length: values.length,
    valueAt(position: number): number | undefined {
      return Number.isSafeInteger(position) && position >= 0 && position < values.length ? values[position] : undefined;
    },
  });
}

export interface GeneratedCatalogSearchArtifact {
  readonly version: 1;
  readonly normalizationVersion: 1;
  readonly maxFoldedItemNameCodePoints: number;
  readonly sourceCatalogChecksums: Readonly<Record<PearlAbyssItemLocale, string>>;
  readonly itemIds: ImmutableNumberColumn;
  readonly grades: ImmutableNumberColumn;
  readonly displayNames: Readonly<Record<PearlAbyssItemLocale, PackedStringColumn>>;
  readonly searchKeys: Readonly<Record<PearlAbyssItemLocale, PackedStringColumn>>;
  readonly indexes: Readonly<Record<PearlAbyssItemLocale, CompactGramIndex>>;
}
