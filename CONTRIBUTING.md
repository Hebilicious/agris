# Contributing

Thanks for helping. Agris is small, so the process is too.

1. Install the toolchain: `proto install`, then `pnpm install`.
2. Make your change on a branch. Read [AGENTS.md](AGENTS.md) for where code belongs and the repository's conventions; it applies to people as much as to coding agents.
3. If you change behaviour, change the matching scenario in `tests/features/` first.
4. If you change a subgraph schema, a persisted operation or catalog data, run `moon run agris:generate` and commit the regenerated files.
5. Run `moon run agris:check`. It must pass.
6. Open a pull request that says what changed and why.

Some things to keep in mind:

- Agris talks to Pearl Abyss's servers on behalf of everyone who deploys it. Changes that raise upstream load (more concurrency, retries, shorter cache windows) need a reason.
- To fix an item name, edit `data/catalog/<locale>/items.json` (and add the `LOCALE:itemId` key to `data/catalog/same-as-english.json` when the correct name equals English), then run `moon run catalog-tools:validate` and `moon run catalog-tools:generate` and commit both. See [docs/research/catalog-names-and-locales.md](docs/research/catalog-names-and-locales.md).
- Website changes live in `website/` (Astro). Preview with `moon run website:dev`. Write for people, not for the code: plain words, no links to files in the repository, and no cache, rate or limit number typed by hand (read it through `website/src/facts.ts`).
- Do not commit account IDs, API tokens or other credentials.
- Report a security problem privately, as [SECURITY.md](SECURITY.md) explains, not in an issue or pull request.

By contributing you agree that your work is released under the [MIT license](LICENSE).
