# Item catalog: locales and maintenance

Pearl Abyss market responses carry numeric item IDs only. Agris supplies names and grades from the item catalog shipped in the repository: 12,508 items in 12 locales, in `tools/catalog/data/<locale>/items.json`. `catalog-tools:generate` turns it into a search artifact bundled into the catalog Worker.

## Contract

- English is the reference. Every locale has exactly the same item IDs and grades as English, in the same order.
- Every non-English name is a real name in that language. A name identical to English is accepted only when `tools/catalog/data/same-as-english.json` lists its `LOCALE:itemId` key, because some names legitimately stay in English.
- No locale contains another script's text, such as Hangul outside Korean.
- Region and locale are independent. Any region's prices can be shown with any locale's names, and both are part of the cache key.

Locales: `EN`, `DE`, `FR`, `ES` (Latin American Spanish), `ES_EU` (European Spanish), `JA`, `KO`, `PT`, `RU`, `TH`, `TR`, `ZH_TW`. Regional English variants are not separate locales.

Each locale directory holds one `items.json`. `same-as-english.json` beside them lists the localized names that legitimately equal the English one; checksums and counts are computed from the files when the catalog is read.

## Checks

`moon run catalog-tools:validate` reads the files and fails when:

- a locale's IDs or grades differ from English;
- a name is empty, in the wrong script, or identical to English without a `same-as-english.json` entry.

`moon run catalog-tools:generate` builds `packages/catalog-subgraph/src/generated-catalog-search-artifact.ts`, and `catalog-tools:search-artifact-check` fails when the committed artifact does not match the data. Generation is deterministic: the same data produces byte-identical output.

## Fixing a name

1. Edit the entry in `tools/catalog/data/<locale>/items.json`. Keep the text exactly as the game shows it: punctuation, spacing, brackets and capitalization are data.
2. If the correct name is identical to English, add its `LOCALE:itemId` key to `tools/catalog/data/same-as-english.json`.
3. Run `moon run catalog-tools:validate`, then `moon run catalog-tools:generate`.
4. Commit the data and the regenerated artifact together, and redeploy the catalog Worker.

## Keeping the catalog current

New items appear with game patches. The catalog is maintained by hand, after a patch is live:

1. Add the new items to every locale with their ID, grade and name. An item enters the catalog once it has a confirmed numeric ID, appears on a live market, and has a grade and all twelve names.
2. Review the diff: added IDs, renamed values, grade changes, removals. A changed count is something to review, not a constant to bump.
3. Validate, generate, and run `moon run agris:check`.
4. Commit and redeploy the catalog Worker.

Rules that keep this safe:

- **Preview content is not data.** Patch-note previews and test-server announcements can flag a candidate item, but they do not provide reliable IDs or final names.
- **A failed update changes nothing.** The deployed Worker keeps serving the previous artifact.
- **Rollback is a redeploy** of the previous committed artifact.
