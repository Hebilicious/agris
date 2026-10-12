import { afterAll } from "vitest";

import { registerFeature } from "../support/vitest-adapter.ts";
import { centralMarketStagingCacheSmokeFeature, stopStagingSmokeCallers } from "./staging-cache-smoke.manifest.ts";

afterAll(stopStagingSmokeCallers);

await registerFeature(centralMarketStagingCacheSmokeFeature, new URL("./staging-cache-smoke.feature", import.meta.url));
