import { reset } from "cloudflare:test";
import { beforeEach } from "vitest";

import featureSource from "./catalog-worker-entrypoint.feature?raw";
import { centralMarketCatalogWorkerEntrypointFeature } from "./catalog-worker-entrypoint.manifest.ts";
import { registerFeatureSource } from "../support/vitest-adapter.ts";

beforeEach(async () => reset());

registerFeatureSource(centralMarketCatalogWorkerEntrypointFeature, featureSource);
