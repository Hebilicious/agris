/**
 * The smoke stage's caller: it forwards `POST /graphql` to the private gateway over its Service Binding, as a host's
 * Worker does.
 *
 * Cloudflare's edge may set its own `CF-Cache-Status` and `Age` on the caller's public response, so the gateway's are
 * copied to `X-Smoke-CF-Cache-Status` and `X-Smoke-Age`, which the smoke reads.
 */
export default {
  async fetch(request: Request, env: SmokeCallerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/graphql" || request.method !== "POST") return new Response("Not found", { status: 404 });
    const response = await env.AGRIS_PROXY.fetch(
      new Request("https://agris-proxy.internal/graphql", {
        method: "POST",
        headers: {
          Accept: "application/graphql-response+json",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: await request.text(),
      }),
    );
    const headers = new Headers(response.headers);
    for (const [name, copy] of [
      ["CF-Cache-Status", "X-Smoke-CF-Cache-Status"],
      ["Age", "X-Smoke-Age"],
    ] as const) {
      const value = response.headers.get(name);
      if (value !== null) headers.set(copy, value);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
} satisfies ExportedHandler<SmokeCallerEnv>;
