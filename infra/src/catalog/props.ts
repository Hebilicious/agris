import type { DeploymentSettings } from "../settings.ts";
import { bundleOptions, compatibility, localPort, observability, privateSurface } from "../stack.ts";

/** The catalog Worker's props in one stage: private, reached only by the gateway. */
export function catalogProps(settings: DeploymentSettings) {
  return {
    name: settings.names.catalog,
    main: new URL("./worker.ts", import.meta.url).href,
    compatibility: compatibility(),
    build: bundleOptions(),
    dev: localPort(8792),
    workersDev: privateSurface(),
    observability: observability(settings.sampling),
  };
}
