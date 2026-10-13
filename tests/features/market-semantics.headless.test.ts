import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { marketSemanticsFeature } from "./market-semantics.manifest.ts";

await registerFeature(marketSemanticsFeature, new NodeUrl("./market-semantics.feature", import.meta.url));
