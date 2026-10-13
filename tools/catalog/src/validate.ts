import { readFile } from "node:fs/promises";

import { readCatalogArtifacts } from "./artifact-files.js";
import { validateCatalog } from "./catalog-validation.js";

const artifacts = await readCatalogArtifacts();
const sameAsEnglish: unknown = JSON.parse(
  await readFile(new URL("../../../data/catalog/same-as-english.json", import.meta.url), "utf8"),
);
validateCatalog(artifacts, sameAsEnglish);

console.log(
  JSON.stringify({
    event: "catalog-valid",
    checksum: artifacts[0]?.manifest.checksum,
    itemCount: artifacts[0]?.items.length,
    locales: artifacts.map(({ manifest }) => manifest.locale),
  }),
);
