import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import { hostCatalogProps, hostGatewayProps, hostMarketProps, smokeCallerProps } from "./props.ts";

/** The cache smoke's Workers, each after the Workers it binds; the stage's output is the caller's address. */
export const smokeStage = Effect.gen(function* () {
  const market = yield* Cloudflare.Worker("HostMarket", hostMarketProps());
  const catalog = yield* Cloudflare.Worker("HostCatalog", hostCatalogProps());
  const gateway = yield* Cloudflare.Worker("HostGateway", hostGatewayProps(market, catalog));
  const caller = yield* Cloudflare.Worker("SmokeCaller", smokeCallerProps(gateway));
  return { url: caller.url };
});
