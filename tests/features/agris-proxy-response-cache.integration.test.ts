import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { agrisProxyResponseCacheFeature } from "./agris-proxy-response-cache.manifest.ts";

await registerFeature(
  agrisProxyResponseCacheFeature,
  new NodeUrl("./agris-proxy-response-cache.feature", import.meta.url),
);
