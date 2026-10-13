import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { pearlAbyssCapabilitiesFeature } from "./pearl-abyss-capabilities.manifest.ts";

await registerFeature(
  pearlAbyssCapabilitiesFeature,
  new NodeUrl("./pearl-abyss-capabilities.feature", import.meta.url),
);
