import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { toolchainInstallFeature } from "./toolchain-install.manifest.ts";

await registerFeature(toolchainInstallFeature, new NodeUrl("./toolchain-install.feature", import.meta.url));
