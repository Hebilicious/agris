/**
 * Bundle every Worker the stack deploys the way Alchemy's deploy bundles it, without a Cloudflare account: the four
 * Workers of a self-hosted stage, and the smoke stage's Workers, which are the Workers' own entrypoints as a host that
 * mounts Agris deploys them.
 *
 * Alchemy otherwise bundles only while it plans or deploys, which both read the account; this proves on every check
 * that each Worker still bundles, and keeps each bundle at `<destination>/<Worker>`, its entry module first in the
 * line it prints. The Workers runtime evidence and the catalog release diagnostic run these bundles.
 *
 * Usage: node bundle.ts <destination-directory> [Worker...]
 */
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { getCompatibility } from "alchemy/Cloudflare/Workers/Compatibility";
import { WorkerBundle } from "alchemy/Cloudflare/Workers/Sources/Rolldown";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { catalogProps } from "./src/catalog/props.ts";
import { gatewayCacheProps, gatewayProps } from "./src/gateway/props.ts";
import { marketProps } from "./src/market/props.ts";
import { DEFAULT_STAGE, selfHostedSettings } from "./src/settings.ts";
import { SMOKE_WORKER_MAIN } from "./src/smoke/props.ts";
import { bundleOptions, compatibility, STACK_NAME } from "./src/stack.ts";

/** A self-hosted deployment with nothing set, as `moon run infra:deploy` deploys it from a clean environment. */
const settings = selfHostedSettings(DEFAULT_STAGE, {});

/**
 * The Durable Object classes a Worker's entry exports. Bundling reads only their names, to export a bridge class for
 * each; the deploy itself fills in the constructor.
 */
const durableObject = {
  kind: "durableObject" as const,
  constructor: Effect.succeed(Effect.die("A bundle-only Durable Object export never runs.")),
  services: Context.empty(),
};

/** A plain Worker module, bundled as Alchemy bundles a Worker that has no Effect implementation. */
function hostWorker(main: string) {
  return {
    props: { main, compatibility: compatibility(), build: bundleOptions() },
    entry: { kind: "external" as const },
  };
}

/** Every Worker by its logical ID. */
const WORKERS = {
  AgrisGateway: { props: gatewayProps(settings), entry: { kind: "effect" as const, exports: {} } },
  AgrisGatewayCache: { props: gatewayCacheProps(settings), entry: { kind: "effect" as const, exports: {} } },
  AgrisMarket: {
    props: marketProps(settings),
    entry: { kind: "effect" as const, exports: { PearlAbyssCoordinator: durableObject } },
  },
  AgrisCatalog: { props: catalogProps(settings), entry: { kind: "effect" as const, exports: {} } },
  HostGateway: hostWorker(SMOKE_WORKER_MAIN.HostGateway),
  HostMarket: hostWorker(SMOKE_WORKER_MAIN.HostMarket),
  HostCatalog: hostWorker(SMOKE_WORKER_MAIN.HostCatalog),
  SmokeCaller: hostWorker(SMOKE_WORKER_MAIN.SmokeCaller),
  // Never deployed: the catalog release diagnostic's search Worker (`tools/catalog`), bundled only when named.
  CatalogSearchArtifact: hostWorker(
    new URL("../tools/catalog/artifact-worker/artifact-worker.ts", import.meta.url).href,
  ),
};

/** The Workers bundled when none is named. */
const DEFAULT_WORKERS: readonly WorkerId[] = [
  "AgrisGateway",
  "AgrisGatewayCache",
  "AgrisMarket",
  "AgrisCatalog",
  "HostGateway",
  "HostMarket",
  "HostCatalog",
  "SmokeCaller",
];

type WorkerId = keyof typeof WORKERS;

function isWorkerId(name: string): name is WorkerId {
  return Object.hasOwn(WORKERS, name);
}

const commandArguments: readonly string[] = process.argv.slice(2);
const [destination, ...requested] = commandArguments;
if (destination === undefined) throw new Error("Usage: bundle.ts <destination-directory> [Worker...]");
const unknown = requested.filter((name) => !isWorkerId(name));
if (unknown.length > 0) {
  throw new Error(`No Worker is named ${unknown.join(", ")}; this bundles ${Object.keys(WORKERS).join(", ")}.`);
}
const selected = requested.length === 0 ? DEFAULT_WORKERS : requested.filter(isWorkerId);

const bundleAll = Effect.gen(function* () {
  const bundler = yield* WorkerBundle;
  for (const id of selected) {
    const { props, entry } = WORKERS[id];
    const directory = resolve(destination, id);
    yield* Effect.promise(() => rm(directory, { recursive: true, force: true }));
    const output = yield* bundler.build({
      id,
      main: props.main,
      compatibility: getCompatibility(props),
      entry,
      stack: { name: STACK_NAME, stage: DEFAULT_STAGE },
      extraOptions: { ...props.build, output: { dir: directory } },
    });
    // The source maps stay beside the modules; Cloudflare receives only the modules.
    const modules = output.files.filter((file) => !file.path.endsWith(".map"));
    const bytes = modules.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
    const entryModule = modules[0]?.path ?? "no module";
    console.log(
      `Bundled ${id}: ${String(modules.length)} modules from ${entryModule}, ${String(bytes)} bytes, at ${directory}.`,
    );
  }
});

await Effect.runPromise(bundleAll.pipe(Effect.provide(NodeServices.layer)));
