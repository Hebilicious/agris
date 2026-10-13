import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { federatedItemMarketSummaryFeature } from "./federated-item-market-summary.manifest.ts";

await registerFeature(
  federatedItemMarketSummaryFeature,
  new NodeUrl("./federated-item-market-summary.feature", import.meta.url),
);
