import { reset } from "cloudflare:test";
import { beforeEach } from "vitest";

import featureSource from "./worker-entrypoints.feature?raw";
import { centralMarketWorkerEntrypointsFeature } from "./worker-entrypoints.manifest.ts";
import { registerFeatureSource } from "../support/vitest-adapter.ts";

beforeEach(async () => reset());

registerFeatureSource(centralMarketWorkerEntrypointsFeature, featureSource);
