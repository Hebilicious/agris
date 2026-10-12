# Catalog tools

`data/` is the item catalog Agris ships: 12,508 items, one `items.json` per locale. `data/same-as-english.json` lists
the localized names that legitimately equal the English one. Checksums and counts are computed from the files, so
nothing else needs editing.

- `moon run catalog-tools:validate` checks every locale against English: same IDs and grades in the same order, a
  native name in the right script for every item, every name that equals English listed in `same-as-english.json`, and
  no listed key left unused. The rules live in `src/catalog-validation.ts`.
- `moon run catalog-tools:generate` rebuilds the catalog subgraph's search artifact from `data/`.

To fix a name, edit the locale's `items.json`, then run both commands.
