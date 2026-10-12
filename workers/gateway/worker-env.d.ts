// The gateway's runtime globals. Its bindings are the explicit `GatewayEnv` in `src/env.ts`, which
// `config-env.check.ts` proves `cloudflare.config.ts` provides.
type GatewayWorkerEnv = import("./src/env.ts").GatewayEnv;

declare namespace Cloudflare {
  interface Env extends GatewayWorkerEnv {}
  interface GlobalProps {
    mainModule: typeof import("./src/index.ts");
  }
}
