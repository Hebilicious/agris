// The smoke caller's bindings, which the smoke stage declares (`infra/src/smoke/props.ts`).
interface SmokeCallerEnv {
  /** The private gateway's default entrypoint. */
  readonly AGRIS_PROXY: Fetcher;
}
