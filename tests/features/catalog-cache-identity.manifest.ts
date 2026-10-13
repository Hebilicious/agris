import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { CATALOG_DATA_IDENTITY, operationResultIdentity } from "../../packages/core/src/protocol/identity.ts";
import { readCatalogArtifacts } from "../../tools/catalog/src/artifact-files.ts";
import { catalogDataIdentity, readCatalogCode } from "../../tools/catalog/src/catalog-identity.ts";
import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";

interface CatalogCacheIdentityWorld {
  shippedIdentity?: string;
  shippedKey?: string;
  renamedKey?: string;
}

const CATALOG_DATA = new URL("../../data/catalog/", import.meta.url);
const DOCUMENT = 'query Catalog{item(id:"44195" locale:EN){name}}';

/* BOUNDARY: The copied catalog file is JSON this test wrote from the shipped catalog; it is checked to be an array. */
function renameFirstItem(serialized: string): string {
  const items: unknown = JSON.parse(serialized);
  assert.ok(Array.isArray(items) && items.length > 0);
  const [first, ...rest] = items;
  assert.ok(typeof first === "object" && first !== null);
  return JSON.stringify([{ ...first, name: "Renamed in a later release" }, ...rest]);
}

const steps: readonly StepDefinition<CatalogCacheIdentityWorld>[] = [
  step(
    "a catalog query's cache key is computed for the shipped catalog and for one with an English name changed",
    noStepArguments,
    async (world) => {
      const code = await readCatalogCode();
      world.shippedIdentity = catalogDataIdentity(await readCatalogArtifacts(CATALOG_DATA), code);
      const directory = await mkdtemp(join(tmpdir(), "agris-catalog-identity-"));
      try {
        await cp(new URL(".", CATALOG_DATA), directory, { recursive: true });
        const english = join(directory, "en", "items.json");
        await writeFile(english, renameFirstItem(await readFile(english, "utf8")), "utf8");
        const renamedIdentity = catalogDataIdentity(await readCatalogArtifacts(pathToFileURL(`${directory}/`)), code);
        world.shippedKey = await operationResultIdentity(DOCUMENT, "{}", world.shippedIdentity);
        world.renamedKey = await operationResultIdentity(DOCUMENT, "{}", renamedIdentity);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  ),
  step(
    "a catalog query's cache key is computed for the shipped catalog code and for one with its search code changed",
    noStepArguments,
    async (world) => {
      const data = await readCatalogArtifacts(CATALOG_DATA);
      const code = await readCatalogCode();
      assert.ok(
        code.some((file) => file.name === "catalog-subgraph/src/item-name-search.ts"),
        "the search code is part of the identity",
      );
      // A later release that ranks or folds names differently, with the same data.
      const changedCode = code.map((file) =>
        file.name === "catalog-subgraph/src/item-name-search.ts"
          ? { ...file, text: `${file.text}\n// a different ranking\n` }
          : file,
      );
      world.shippedKey = await operationResultIdentity(DOCUMENT, "{}", catalogDataIdentity(data, code));
      world.renamedKey = await operationResultIdentity(DOCUMENT, "{}", catalogDataIdentity(data, changedCode));
    },
  ),
  step("the two keys differ", noStepArguments, (world) => {
    assert.ok(world.shippedKey && world.renamedKey);
    assert.notEqual(world.renamedKey, world.shippedKey);
  }),
  step("the gateway's cache keys use the shipped catalog's identity", noStepArguments, async (world) => {
    assert.equal(CATALOG_DATA_IDENTITY, world.shippedIdentity, "run moon run catalog-tools:generate");
    assert.equal(await operationResultIdentity(DOCUMENT, "{}"), world.shippedKey);
  }),
];

export const catalogCacheIdentityFeature: ExecutableFeatureManifest<CatalogCacheIdentityWorld> = {
  id: "catalog-cache-identity",
  uri: "tests/features/catalog-cache-identity.feature",
  createWorld: () => ({}),
  steps,
};
