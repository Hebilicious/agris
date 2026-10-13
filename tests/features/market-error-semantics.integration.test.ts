import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { marketErrorSemanticsFeature } from "./market-error-semantics.manifest.ts";

await registerFeature(marketErrorSemanticsFeature, new NodeUrl("./market-error-semantics.feature", import.meta.url));
