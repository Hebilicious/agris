import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { catalogCacheIdentityFeature } from "./catalog-cache-identity.manifest.ts";

await registerFeature(catalogCacheIdentityFeature, new NodeUrl("./catalog-cache-identity.feature", import.meta.url));
