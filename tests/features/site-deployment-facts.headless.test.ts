import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { siteDeploymentFactsFeature } from "./site-deployment-facts.manifest.ts";

await registerFeature(siteDeploymentFactsFeature, new NodeUrl("./site-deployment-facts.feature", import.meta.url));
