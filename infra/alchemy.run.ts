import { fileURLToPath } from "node:url";

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import AgrisCatalogLive from "./src/catalog/worker.ts";
import AgrisGatewayCacheLive from "./src/gateway/cache-worker.ts";
import { AgrisGateway } from "./src/gateway/contract.ts";
import AgrisGatewayLive from "./src/gateway/worker.ts";
import AgrisMarketLive from "./src/market/worker.ts";
import { DOCS_STAGE, DOCS_WORKER_NAME, stageSettings } from "./src/settings.ts";
import { SMOKE_STAGE } from "./src/smoke/props.ts";
import { smokeStage } from "./src/smoke/stage.ts";
import { deployEnvironment, STACK_NAME } from "./src/stack.ts";

/**
 * Agris as one Alchemy stack; the stage names what it deploys.
 *
 * - `docs`: the static website (`website/dist`, built by `moon run website:build`) as an assets-only Worker, `agris-docs`.
 *   Cloudflare serves every request from its asset layer, so no Worker code runs and asset requests are free.
 * - `demo`: the maintainer's shared, heavily limited API (`agris-demo`), with the figures `src/settings.ts` fixes.
 * - `smoke`: the cache smoke's private gateway, market and catalog Workers, deployed from their own entrypoints as a
 *   host deploys them, and a caller bound to the gateway (`src/smoke/`).
 * - any other stage: a self-hosted API, named `agris` for `production` and `agris-<stage>` otherwise, configured from
 *   the deploy command's environment (`src/settings.ts`).
 *
 * An API stage deploys four Workers: the public gateway, its cache Worker, and the market and catalog subgraphs, which
 * only the gateway reaches. Each Worker declares itself in `src/<name>/worker.ts`; this file composes them, providing a
 * Worker's layer below the Workers that bind it.
 */

const SITE_DIST = fileURLToPath(new URL("../website/dist", import.meta.url));

const subgraphs = Layer.mergeAll(AgrisMarketLive, AgrisCatalogLive);
const api = AgrisGatewayLive.pipe(Layer.provideMerge(AgrisGatewayCacheLive), Layer.provideMerge(subgraphs));

const docs = Effect.gen(function* () {
  const site = yield* Cloudflare.Worker("AgrisDocs", { name: DOCS_WORKER_NAME, assets: SITE_DIST });
  return { url: site.url };
});

const gateway = Effect.gen(function* () {
  const worker = yield* AgrisGateway;
  return { url: worker.url };
}).pipe(Effect.provide(api));

export default Alchemy.Stack(
  STACK_NAME,
  {
    providers: Cloudflare.providers(),
    // `alchemy dev` runs every Worker on this machine and keeps its state here too, so `moon run agris:dev` needs no
    // account and writes nothing to the account's state store.
    state: deployEnvironment().ALCHEMY_DEV === "true" ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    if (stage === DOCS_STAGE) return yield* docs;
    if (stage === SMOKE_STAGE) return yield* smokeStage;
    // Refuse a bad setting before anything is uploaded; every Worker's props read the same settings.
    stageSettings(stage, deployEnvironment());
    return yield* gateway;
  }),
);
