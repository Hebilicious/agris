import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { deploySettingsFeature } from "./deploy-settings.manifest.ts";

await registerFeature(deploySettingsFeature, new NodeUrl("./deploy-settings.feature", import.meta.url));
