import * as Predicate from "effect/Predicate";

/** A binding the Worker reaches with an HTTP request: another Worker's service binding. */
export interface HttpServiceBinding {
  fetch(request: Request): Promise<Response>;
}

/**
 * The HTTP binding an Alchemy Worker declared under `name`.
 *
 * A Workers RPC stub types its `fetch` as the bound Worker's handler, and Workers Cache answers only HTTP requests, so
 * a Worker that must send a real request reads the binding from its environment.
 */
/* BOUNDARY: The Worker environment is untyped; the binding is checked to be an HTTP service before it is called. */
export function httpServiceBinding(env: object, name: string): HttpServiceBinding {
  const binding: unknown = Predicate.hasProperty(env, name) ? env[name] : undefined;
  if (!Predicate.hasProperty(binding, "fetch") || !Predicate.isFunction(binding.fetch)) {
    throw new TypeError(`The Worker has no ${name} binding.`);
  }
  const fetch = binding.fetch;
  return { fetch: (request) => fetch.call(binding, request) };
}
