import type { SmokeGatewayEnv } from "@agris/gateway-worker/env";
import type { MarketEnv } from "@agris/market-worker/env";
import type * as Cloudflare from "alchemy/Cloudflare";

import type { hostGatewayProps, hostMarketProps } from "./props.ts";

/**
 * Fails to type-check when the smoke stage stops providing the bindings an entrypoint reads. The stage names the
 * coordinator class only as a string, so its namespace is compared untyped.
 */
type Provides<TConfigured extends TRequired, TRequired> = [TConfigured, TRequired];
type ProvidedEnv<TProps extends (...args: never[]) => { readonly env: object }> = Cloudflare.InferEnv<
  ReturnType<TProps>["env"]
>;
type RequiredMarketEnv = Omit<MarketEnv, "PA_COORDINATOR"> & { readonly PA_COORDINATOR: DurableObjectNamespace };

export type SmokeStageProvidesBindings = [
  Provides<ProvidedEnv<typeof hostMarketProps>, RequiredMarketEnv>,
  Provides<ProvidedEnv<typeof hostGatewayProps>, SmokeGatewayEnv>,
];
