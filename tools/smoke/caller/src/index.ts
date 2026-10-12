export default {
  async fetch(request: Request, env: SmokeCallerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/graphql" || request.method !== "POST") return new Response("Not found", { status: 404 });
    return env.AGRIS_PROXY.fetch(
      new Request("https://agris-proxy.internal/graphql", {
        method: "POST",
        headers: {
          Accept: "application/graphql-response+json",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: await request.text(),
      }),
    );
  },
} satisfies ExportedHandler<SmokeCallerEnv>;
