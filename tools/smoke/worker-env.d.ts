// The smoke caller's bindings, inferred from its configuration.
type SmokeCallerConfig = typeof import("./cloudflare.config.ts");
type InferredSmokeCallerEnv = import("cf/config").InferEnv<
  import("cf/config").UnwrapConfig<SmokeCallerConfig["remoteWorker"]>
>;

interface SmokeCallerEnv extends InferredSmokeCallerEnv {}
