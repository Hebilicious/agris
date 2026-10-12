import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { centralMarketCatalogResolutionFeature } from "./catalog-resolution.manifest.ts";

await registerFeature(
  centralMarketCatalogResolutionFeature,
  new NodeUrl("./catalog-resolution.feature", import.meta.url),
);
