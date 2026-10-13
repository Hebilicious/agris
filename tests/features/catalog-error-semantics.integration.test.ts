import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { catalogErrorSemanticsFeature } from "./catalog-error-semantics.manifest.ts";

await registerFeature(catalogErrorSemanticsFeature, new NodeUrl("./catalog-error-semantics.feature", import.meta.url));
