import { registerFeature } from "../support/vitest-adapter.ts";
import { deployedCacheSmokeFeature } from "./deployed-cache-smoke.manifest.ts";

await registerFeature(deployedCacheSmokeFeature, new URL("./deployed-cache-smoke.feature", import.meta.url));
