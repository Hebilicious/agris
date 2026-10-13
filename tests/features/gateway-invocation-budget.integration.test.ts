import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { gatewayInvocationBudgetFeature } from "./gateway-invocation-budget.manifest.ts";

await registerFeature(
  gatewayInvocationBudgetFeature,
  new NodeUrl("./gateway-invocation-budget.feature", import.meta.url),
);
