import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { selectionAwareMarketFeature } from "./selection-aware-market.manifest.ts";

await registerFeature(selectionAwareMarketFeature, new NodeUrl("./selection-aware-market.feature", import.meta.url));
