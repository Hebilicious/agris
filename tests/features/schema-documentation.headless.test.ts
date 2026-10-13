import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { schemaDocumentationFeature } from "./schema-documentation.manifest.ts";

await registerFeature(schemaDocumentationFeature, new NodeUrl("./schema-documentation.feature", import.meta.url));
