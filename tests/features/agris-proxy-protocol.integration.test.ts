import { URL as NodeUrl } from "node:url";

import { registerFeature } from "../support/vitest-adapter.ts";
import { agrisProxyProtocolFeature } from "./agris-proxy-protocol.manifest.ts";

await registerFeature(agrisProxyProtocolFeature, new NodeUrl("./agris-proxy-protocol.feature", import.meta.url));
