import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { centralMarketGraphContractFeature } from "./graph-contract.manifest.ts";

await registerFeature(centralMarketGraphContractFeature, new NodeUrl("./graph-contract.feature", import.meta.url));
