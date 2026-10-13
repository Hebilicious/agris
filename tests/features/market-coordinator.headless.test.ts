import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { marketCoordinatorFeature } from "./market-coordinator.manifest.ts";

await registerFeature(marketCoordinatorFeature, new NodeUrl("./market-coordinator.feature", import.meta.url));
