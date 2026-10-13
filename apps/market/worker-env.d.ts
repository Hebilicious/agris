// The market Worker's runtime globals. Its bindings are the explicit `MarketEnv` in `src/env.ts`.
type MarketWorkerEnv = import("./src/env.ts").MarketEnv;

declare namespace Cloudflare {
  interface Env extends MarketWorkerEnv {}
  interface GlobalProps {
    mainModule: typeof import("./src/index.ts");
    durableNamespaces: "PearlAbyssCoordinator";
  }
}
