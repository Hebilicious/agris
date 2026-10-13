import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { publicQueryProtocolFeature } from "./public-query-protocol.manifest.ts";

await registerFeature(publicQueryProtocolFeature, new NodeUrl("./public-query-protocol.feature", import.meta.url));
