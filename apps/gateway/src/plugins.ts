import type { GatewayPlugin } from "@graphql-hive/gateway-runtime";

/**
 * Your Envelop plugins: the gateway's extension point.
 *
 * Every operation the gateway executes runs through Hive Gateway, and Hive Gateway runs every Envelop plugin
 * (https://the-guild.dev/graphql/envelop/plugins) listed here after Agris's own subgraph fetch. A plugin can log or
 * trace operations, add to the response's `extensions`, or refuse an operation. It is empty by default; add a plugin to
 * the list and deploy. A plugin package (`@envelop/*`, `@graphql-hive/*`) joins the `catalog:` in `pnpm-workspace.yaml`
 * and this Worker's `package.json` first.
 *
 * What a plugin sees: the operation as the gateway validated it, on every execution. An answer the edge cache serves
 * never reaches the gateway, so a plugin runs on a cache miss, a refresh or an uncached operation, not on a cache hit.
 * The public gateway's rate limits, query limits and request validation have already run.
 */
export const gatewayPlugins: readonly GatewayPlugin[] = [
  // Example: log each operation's name and how long its execution took.
  //
  // {
  //   onExecute({ args }) {
  //     const startedAt = Date.now();
  //     return {
  //       onExecuteDone() {
  //         console.info({ operation: args.operationName ?? null, milliseconds: Date.now() - startedAt });
  //       },
  //     };
  //   },
  // },
];
