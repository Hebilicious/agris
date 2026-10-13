# Research notes

Background for the decisions in Agris, rewritten from the original investigation notes. Dated observations of undocumented third-party behaviour can go stale; check before relying on a number.

- [Pearl Abyss Central Market endpoints](pearl-abyss-market-endpoints.md): the seven trade endpoints, request bodies, row formats, regional hosts, and the concurrency defaults. Based on [Arsha](https://github.com/guy0090/api.arsha.io)'s open-source implementation.
- [Item catalog: locales and maintenance](catalog-names-and-locales.md): the catalog's contract, its checks, and how to fix a name or add items after a patch.
- [In-memory item-name search](in-memory-name-search.md): the folding rules, the trigram index, and the alternatives that were measured.
- [Catalog name sources in Pearl Abyss game files](catalog-name-sources.md): which locales the client's own language files can supply item names for, and why the catalog was left unchanged.
