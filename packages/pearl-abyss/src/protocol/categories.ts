export interface PearlAbyssMarketCategory {
  readonly main: number;
  readonly sub: number;
}

// Current Central Market pairs derived from Arsha's develop/src/main/resources/categories.json.
// Update procedure: compare that complete upstream file, preserve its deliberate numeric gaps,
// update this map in one reviewable change, then run pearl-abyss:typecheck and
// tests:test-headless before regenerating/deploying the graph.
const SUBCATEGORIES_BY_MAIN = {
  1: range(1, 24),
  5: range(1, 22),
  10: [...range(1, 17), ...range(19, 30)],
  15: range(1, 6),
  20: range(1, 4),
  25: range(1, 8),
  30: range(1, 3),
  35: range(1, 8),
  40: range(1, 10),
  45: range(1, 4),
  50: range(1, 4),
  55: range(1, 8),
  60: range(1, 8),
  65: [...range(1, 7), ...range(9, 13)],
  70: range(1, 9),
  75: range(1, 6),
  80: range(1, 9),
  85: range(1, 6),
} as const satisfies Readonly<Record<number, readonly number[]>>;

export const PEARL_ABYSS_MARKET_CATEGORIES: readonly PearlAbyssMarketCategory[] = Object.entries(
  SUBCATEGORIES_BY_MAIN,
).flatMap(([main, subcategories]) => subcategories.map((sub) => ({ main: Number(main), sub })));

export function pearlAbyssCategoriesFor(
  category: { readonly main: number; readonly sub: number | null } | null,
): readonly PearlAbyssMarketCategory[] {
  if (category === null) return PEARL_ABYSS_MARKET_CATEGORIES;
  const pairs = PEARL_ABYSS_MARKET_CATEGORIES.filter(
    (pair) => pair.main === category.main && (category.sub === null || pair.sub === category.sub),
  );
  if (pairs.length === 0) throw new RangeError("Unsupported Pearl Abyss Central Market category");
  return pairs;
}

function range(first: number, last: number): readonly number[] {
  return Array.from({ length: last - first + 1 }, (_unused, index) => first + index);
}
