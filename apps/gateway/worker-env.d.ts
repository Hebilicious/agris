// The gateway's runtime globals. Its bindings are the explicit `GatewayEnv` in `src/env.ts`.
type GatewayWorkerEnv = import("./src/env.ts").GatewayEnv;

declare namespace Cloudflare {
  interface Env extends GatewayWorkerEnv {}
  interface GlobalProps {
    mainModule: typeof import("./src/index.ts");
  }
}
