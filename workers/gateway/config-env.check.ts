import type { InferEnv, UnwrapConfig } from "cf/config";

import type * as Config from "./cloudflare.config.ts";
import type { GatewayEnv, LocalGatewayEnv, PublicGatewayEnv, SmokeGatewayEnv } from "./src/env.ts";

/** Fails to type-check when a mode in `cloudflare.config.ts` stops providing the bindings its entrypoint reads. */
type Provides<TConfigured extends TRequired, TRequired> = [TConfigured, TRequired];
type ConfiguredEnv<TWorker> = InferEnv<UnwrapConfig<TWorker>>;

/** The public modes must bind every optional binding they configure with the type `src/public.ts` reads. */
type ProductionPublicEnv = GatewayEnv & Required<Pick<PublicGatewayEnv, "CLIENT_RATE_LIMITER">>;
type DemoPublicEnv = Required<PublicGatewayEnv>;

export type GatewayConfigurationProvidesBindings = [
  Provides<ConfiguredEnv<typeof Config.productionWorker>, ProductionPublicEnv>,
  Provides<ConfiguredEnv<typeof Config.stagingWorker>, GatewayEnv>,
  Provides<ConfiguredEnv<typeof Config.smokeWorker>, SmokeGatewayEnv>,
  Provides<ConfiguredEnv<typeof Config.demoWorker>, DemoPublicEnv>,
  Provides<ConfiguredEnv<typeof Config.localWorker>, LocalGatewayEnv>,
];
