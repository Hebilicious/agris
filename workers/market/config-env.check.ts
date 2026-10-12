import type { InferEnv, UnwrapConfig } from "cf/config";

import type * as Config from "./cloudflare.config.ts";
import type { MarketEnv } from "./src/env.ts";

/**
 * Fails to type-check when a mode in `cloudflare.config.ts` stops providing the bindings the market Worker reads. The
 * configuration names the coordinator class only as a string, so its namespace is compared untyped.
 */
type Provides<TConfigured extends TRequired, TRequired> = [TConfigured, TRequired];
type ConfiguredEnv<TWorker> = InferEnv<UnwrapConfig<TWorker>>;
type RequiredEnv = Omit<MarketEnv, "PA_COORDINATOR"> & { readonly PA_COORDINATOR: DurableObjectNamespace };

export type MarketConfigurationProvidesBindings = [
  Provides<ConfiguredEnv<typeof Config.productionWorker>, RequiredEnv>,
  Provides<ConfiguredEnv<typeof Config.stagingWorker>, RequiredEnv>,
  Provides<ConfiguredEnv<typeof Config.demoWorker>, RequiredEnv>,
  Provides<ConfiguredEnv<typeof Config.localWorker>, RequiredEnv>,
];
