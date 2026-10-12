import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { readCatalogArtifacts } from "./artifact-files.js";
import { createCatalogSearchArtifact, serializeCatalogSearchArtifactModule } from "./search-artifact.js";

const outputUrl = new URL(
  "../../../packages/catalog-subgraph/src/generated-catalog-search-artifact.ts",
  import.meta.url,
);
const sources = await readCatalogArtifacts();
const artifact = createCatalogSearchArtifact(sources);
await mkdir(fileURLToPath(new URL("./", outputUrl)), { recursive: true });
await writeFile(outputUrl, serializeCatalogSearchArtifactModule(artifact), "utf8");
console.log(
  JSON.stringify({
    event: "catalog-search-artifact-generated",
    version: artifact.version,
    normalizationVersion: artifact.normalizationVersion,
    itemCount: artifact.itemIds.length,
    locales: Object.keys(artifact.displayNames),
    maxFoldedItemNameCodePoints: artifact.maxFoldedItemNameCodePoints,
  }),
);
