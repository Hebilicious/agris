// Declares `globalThis.__ALCHEMY_RUNTIME__`.
import type {} from "alchemy/Phase";

/** The Alchemy stack every Agris Worker deploys in, which Alchemy writes into each Effect-native Worker's entry. */
export const STACK_NAME = "Agris";

/**
 * A Worker's props, which only a deploy reads.
 *
 * The deployed Worker evaluates its props too, and there the module may have no URL to resolve the Worker's entry
 * against and no deploy environment to read settings from, so it states only its own entry. Alchemy's bundler folds
 * `__ALCHEMY_RUNTIME__` to true, so a deployed Worker always takes that branch and never calls `props`.
 */
export function deployProps<Props>(
  main: string | undefined,
  props: () => Props,
): Props | { readonly main: string | undefined } {
  return globalThis.__ALCHEMY_RUNTIME__ ? { main } : props();
}

/** The deploy command's environment, where a self-hosted stage reads its settings. */
export function deployEnvironment(): Readonly<Record<string, string | undefined>> {
  return process.env;
}

/**
 * The Workers runtime settings every Agris Worker deploys with.
 *
 * `enable_request_signal` makes an incoming request's `signal` abort when its caller goes away; without it the signal
 * never fires. The Pearl Abyss coordinator relies on it: a market read whose caller gives up leaves the coordinator's
 * queue instead of being sent anyway. The Workers runtime tests in `tests/` run with the same flags.
 */
export function compatibility(): { date: string; flags: string[] } {
  return { date: "2026-08-24", flags: ["nodejs_compat", "enable_request_signal"] };
}

/** Rolldown's options for every Worker bundle: ES2026 output, which the Workers runtime runs without lowering. */
export function bundleOptions() {
  return { input: { transform: { target: "es2026" } } };
}

/** Where `alchemy dev` (`moon run agris:dev`) serves a Worker on this machine; a deploy ignores it. */
export function localPort(port: number) {
  return { port };
}

/** A Worker only another Worker in the account reaches, through its service binding. */
export function privateSurface(): { enabled: boolean; previewsEnabled: boolean } {
  return { enabled: false, previewsEnabled: false };
}

/**
 * A Worker's subrequest ceiling, and the same number as the `SUBREQUEST_LIMIT` variable its budget reads, so the
 * runtime refuses work with a `QUERY_BUDGET_EXCEEDED` error before the platform would throw.
 */
export function subrequestLimit(limit: number) {
  return { limits: { subrequests: limit }, variable: { SUBREQUEST_LIMIT: String(limit) } };
}

/** Observability that keeps `logs` of invocations and `traces` of them, each a share from 0 to 1. */
export function observability(sampling: { readonly logs: number; readonly traces: number }) {
  return {
    enabled: true,
    logs: { enabled: true, invocationLogs: true, headSamplingRate: sampling.logs },
    traces: { enabled: true, headSamplingRate: sampling.traces },
  };
}
