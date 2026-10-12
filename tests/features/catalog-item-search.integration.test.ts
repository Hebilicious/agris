import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { catalogItemSearchFeature } from "./catalog-item-search.manifest.ts";

await registerFeature(catalogItemSearchFeature, new NodeUrl("./catalog-item-search.feature", import.meta.url));
