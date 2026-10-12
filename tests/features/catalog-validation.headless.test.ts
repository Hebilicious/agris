import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { catalogValidationFeature } from "./catalog-validation.manifest.ts";

await registerFeature(catalogValidationFeature, new NodeUrl("./catalog-validation.feature", import.meta.url));
