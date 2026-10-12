import { reset } from "cloudflare:test";
import { beforeEach } from "vitest";

import featureSource from "./public-gateway.feature?raw";
import { publicGatewayFeature } from "./public-gateway.manifest.ts";
import { registerFeatureSource } from "../support/vitest-adapter.ts";

beforeEach(async () => reset());

registerFeatureSource(publicGatewayFeature, featureSource);
