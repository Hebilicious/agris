import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { centralMarketRequestSafetyFeature } from "./request-safety.manifest.ts";

await registerFeature(centralMarketRequestSafetyFeature, new NodeUrl("./request-safety.feature", import.meta.url));
