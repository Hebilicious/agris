import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { cacheFreshnessConfigurationFeature } from "./cache-freshness-configuration.manifest.ts";

await registerFeature(
  cacheFreshnessConfigurationFeature,
  new NodeUrl("./cache-freshness-configuration.feature", import.meta.url),
);
