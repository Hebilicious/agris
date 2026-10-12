import assert from "node:assert/strict";
import { env, createExecutionContext } from "cloudflare:test";
import { withExports } from "cloudflare:workers";
import { getIntrospectionQuery } from "graphql";
import * as v from "valibot";

import {
  executeAgrisProxy,
  serviceBindingPort,
  type AgrisProxyExecutionProps,
  type AgrisProxyRuntimeEnv,
} from "../../workers/gateway/src/index.ts";
import { publicAgrisProxyWorker, type PublicGatewayEnv, type RateLimitPort } from "../../workers/gateway/src/public.ts";

import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";

const ORIGIN = "https://agris.example";
const DEPLOY_GUIDE_URL = "https://agris.example/#deploy";
const DEMO_NOTICE = "Shared demo, rate-limited.";
const SITE_HOME = "<!doctype html><title>Agris</title>";
const PERSISTED_OPERATION_ID = "2e23b7343c2a4c210e1d83395e8c3fe2a393af63840cac8f4e58b3e79d9f87a6";
const MARKET_ITEM_QUERY =
  "query PublicMarketItem($region: MarketRegion!, $ids: [ID!]!) { market(region: $region) { items(ids: $ids) { item { id name } basePrice } } }";
const MARKET_ITEM_VARIABLES = { region: "NA", ids: ["10006"] };

interface PublicGatewayWorld {
  responses?: readonly Response[];
  bodies?: readonly unknown[];
  pearlAbyssRequestsBefore?: number;
  gatewayEnv?: PublicGatewayEnv;
}

const catalogEntitiesRequestSchema = v.looseObject({
  variables: v.looseObject({
    representations: v.array(v.looseObject({ __typename: v.literal("Item"), id: v.string(), locale: v.string() })),
  }),
});
const marketItemBodySchema = v.looseObject({
  data: v.looseObject({
    market: v.looseObject({
      items: v.array(
        v.looseObject({ item: v.looseObject({ id: v.string(), name: v.nullable(v.string()) }), basePrice: v.number() }),
      ),
    }),
  }),
});
const rateLimitedBodySchema = v.strictObject({
  errors: v.tuple([
    v.strictObject({
      message: v.string(),
      extensions: v.strictObject({ code: v.literal("RATE_LIMITED"), scope: v.picklist(["client", "global"]) }),
    }),
  ]),
});
const pearlAbyssObservationSchema = v.strictObject({ distinct: v.number(), total: v.number() });

const steps: readonly StepDefinition<PublicGatewayWorld>[] = [
  step(
    "the same market item is requested from the public gateway by POST, by GET and by persisted id",
    noStepArguments,
    async (world) => {
      const variables = encodeURIComponent(JSON.stringify(MARKET_ITEM_VARIABLES));
      const requests = [
        new Request(`${ORIGIN}/graphql`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: MARKET_ITEM_QUERY, variables: MARKET_ITEM_VARIABLES }),
        }),
        new Request(`${ORIGIN}/graphql?query=${encodeURIComponent(MARKET_ITEM_QUERY)}&variables=${variables}`),
        new Request(`${ORIGIN}/graphql?id=${PERSISTED_OPERATION_ID}&variables=${variables}`),
      ];
      const responses: Response[] = [];
      for (const request of requests) responses.push(await fetchPublicGateway(request, publicEnv()));
      world.responses = responses;
      world.bodies = await Promise.all(responses.map((response) => response.clone().json()));
    },
  ),
  step("all three responses return the Pearl Abyss item with its catalog name", noStepArguments, (world) => {
    assert.deepEqual(
      requiredResponses(world).map((response) => response.status),
      [200, 200, 200],
      JSON.stringify(world.bodies),
    );
    for (const body of world.bodies ?? []) {
      const parsed = v.parse(marketItemBodySchema, body);
      assert.deepEqual(
        parsed.data.market.items.map(({ item, basePrice }) => ({ id: item.id, name: item.name, basePrice })),
        [{ id: "10006", name: "Catalog item 10006", basePrice: 377_000 }],
      );
    }
  }),
  step("every response allows any origin", noStepArguments, (world) => {
    for (const response of requiredResponses(world)) {
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    }
  }),
  step("a browser sends a CORS preflight for the GraphQL path", noStepArguments, async (world) => {
    const request = new Request(`${ORIGIN}/graphql`, {
      method: "OPTIONS",
      headers: { Origin: "https://elsewhere.example", "Access-Control-Request-Method": "POST" },
    });
    world.responses = [await fetchPublicGateway(request, publicEnv())];
  }),
  step(
    "the gateway answers 204 allowing GET, POST and OPTIONS with a Content-Type header",
    noStepArguments,
    (world) => {
      const response = requiredResponse(world, 0);
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
      assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
      assert.match(response.headers.get("Access-Control-Allow-Headers") ?? "", /Content-Type/u);
    },
  ),
  step("a caller is over the client rate limit", noStepArguments, async (world) => {
    world.pearlAbyssRequestsBefore ??= (await readPearlAbyssObservation()).total;
    const response = await fetchPublicGateway(
      marketItemPost(),
      publicEnv({ CLIENT_RATE_LIMITER: limiter(false), GLOBAL_RATE_LIMITER: limiter(true) }),
    );
    world.responses = [response];
  }),
  step(
    "the gateway answers 429 for the client scope with Retry-After 60 and the deploy guide",
    noStepArguments,
    async (world) => {
      await assertRateLimited(requiredResponse(world, 0), "client");
    },
  ),
  step(
    "a caller is within the client rate limit while the deployment is over the global rate limit",
    noStepArguments,
    async (world) => {
      const response = await fetchPublicGateway(
        marketItemPost(),
        publicEnv({ CLIENT_RATE_LIMITER: limiter(true), GLOBAL_RATE_LIMITER: limiter(false) }),
      );
      world.responses = [response];
    },
  ),
  step(
    "the gateway answers 429 for the global scope with Retry-After 60 and the deploy guide",
    noStepArguments,
    async (world) => {
      await assertRateLimited(requiredResponse(world, 0), "global");
    },
  ),
  step("no rate-limited request reached Pearl Abyss", noStepArguments, async (world) => {
    assert.equal((await readPearlAbyssObservation()).total, world.pearlAbyssRequestsBefore);
  }),
  step("a public gateway with a demo notice and a static site", noStepArguments, (world) => {
    world.gatewayEnv = publicEnv({ DEMO_NOTICE, ASSETS: staticSite() });
  }),
  step(
    "a caller requests the health path, the site's home page and the GraphQL path",
    noStepArguments,
    async (world) => {
      assert.ok(world.gatewayEnv);
      world.responses = await requestEveryPath(world.gatewayEnv);
    },
  ),
  step("every response carries the demo notice", noStepArguments, (world) => {
    for (const response of requiredResponses(world)) assert.equal(response.headers.get("X-Agris-Demo"), DEMO_NOTICE);
  }),
  step("the health path reports ok and the home page comes from the site", noStepArguments, async (world) => {
    const [health, home] = requiredResponses(world);
    assert.ok(health && home);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(home.status, 200);
    assert.equal(await home.text(), SITE_HOME);
  }),
  step("the same paths are requested from a public gateway without a site", noStepArguments, async (world) => {
    world.responses = await requestEveryPath(publicEnv());
  }),
  step("the home page is a JSON 404 that points to the GraphQL path", noStepArguments, async (world) => {
    const home = requiredResponse(world, 1);
    assert.equal(home.status, 404);
    assert.equal(home.headers.get("X-Agris-Demo"), null);
    const body = v.parse(
      v.strictObject({ errors: v.tuple([v.strictObject({ message: v.string() })]) }),
      await home.json(),
    );
    assert.match(body.errors[0].message, /\/graphql/u);
  }),
  step("a browser opens a link to the GraphQL path that carries a query", noStepArguments, async (world) => {
    const link = new Request(`${ORIGIN}/graphql?query=${encodeURIComponent("{ __typename }")}`, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    world.responses = [await fetchPublicGateway(link, publicEnv())];
  }),
  step("the gateway answers with a GraphiQL page that keeps the link's query", noStepArguments, async (world) => {
    const page = requiredResponse(world, 0);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("Content-Type") ?? "", /^text\/html/u);
    // GraphiQL reads the link's `?query=` itself; a `query` option on the page would replace it.
    assert.doesNotMatch(await page.text(), /"query":/u);
  }),
  step("a browser opens the GraphQL path", noStepArguments, async (world) => {
    world.responses = [await fetchPublicGateway(browserGraphqlRequest(), publicEnv())];
  }),
  step("the gateway answers with the GraphiQL page", noStepArguments, async (world) => {
    const page = requiredResponse(world, 0);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("Content-Type") ?? "", /^text\/html/u);
    const html = await page.text();
    assert.match(html, /<title>[^<]*GraphiQL[^<]*<\/title>/u);
    assert.match(html, /"endpoint":"\/graphql"/u);
    // GraphiQL opens on an example market query rather than its own welcome comment.
    assert.match(html, /"query":"[^"]*market\(/u);
  }),
  step("GraphiQL sends its introspection query", noStepArguments, async (world) => {
    const request = new Request(`${ORIGIN}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Exactly what GraphiQL sends, `extensions` included.
      body: JSON.stringify({ query: getIntrospectionQuery(), operationName: "IntrospectionQuery", extensions: {} }),
    });
    const response = await fetchPublicGateway(request, publicEnv());
    world.responses = [response];
    world.bodies = [await response.clone().json()];
  }),
  step("the gateway answers with the client schema", noStepArguments, (world) => {
    assert.equal(requiredResponse(world, 0).status, 200, JSON.stringify(world.bodies));
    const body = v.parse(introspectionBodySchema, world.bodies?.[0]);
    assert.equal(body.data.__schema.queryType.name, "Query");
    const typeNames = body.data.__schema.types.map(({ name }) => name);
    for (const name of ["Item", "Market", "MarketRegion"]) assert.ok(typeNames.includes(name), name);
  }),
  step("a browser opens the GraphQL path on a gateway with GraphiQL disabled", noStepArguments, async (world) => {
    world.responses = [await fetchPublicGateway(browserGraphqlRequest(), publicEnv({ GRAPHIQL: "disabled" }))];
  }),
  step("the gateway answers that a query is required instead of GraphiQL", noStepArguments, async (world) => {
    const response = requiredResponse(world, 0);
    assert.equal(response.status, 400);
    assert.doesNotMatch(response.headers.get("Content-Type") ?? "", /text\/html/u);
    const body = v.parse(
      v.looseObject({ errors: v.tuple([v.looseObject({ message: v.string() })]) }),
      await response.json(),
    );
    assert.ok(body.errors.length > 0);
  }),
];

const introspectionBodySchema = v.looseObject({
  data: v.looseObject({
    __schema: v.looseObject({
      queryType: v.looseObject({ name: v.string() }),
      types: v.array(v.looseObject({ name: v.string() })),
    }),
  }),
});

function browserGraphqlRequest(): Request {
  return new Request(`${ORIGIN}/graphql`, { headers: { Accept: "text/html,application/xhtml+xml" } });
}

export const publicGatewayFeature: ExecutableFeatureManifest<PublicGatewayWorld> = {
  id: "public-gateway",
  uri: "tests/features/public-gateway.feature",
  createWorld: () => ({}),
  steps,
};

/** The real market Worker, a catalog that names every item it is asked about, and whatever optional bindings a case needs. */
function publicEnv(overrides: Partial<PublicGatewayEnv> = {}): PublicGatewayEnv {
  // SAFETY: The Workers pool binds MARKET to the real market Worker's BudgetedMarketSubgraph entrypoint, and the
  // catalog fake implements the one method the gateway's service binding port calls.
  const bindings = { MARKET: env.MARKET, CATALOG: namingCatalog } as unknown as PublicGatewayEnv;
  return { ...bindings, DEPLOY_GUIDE_URL, ...overrides };
}

const namingCatalog = {
  async fetchWithBudget(request: Request): Promise<Response> {
    const { variables } = v.parse(catalogEntitiesRequestSchema, await request.json());
    return Response.json({
      data: {
        _entities: variables.representations.map(({ id, locale }) => ({
          __typename: "Item",
          id,
          locale,
          name: `Catalog item ${id}`,
        })),
      },
    });
  },
};

async function fetchPublicGateway(request: Request, gatewayEnv: PublicGatewayEnv): Promise<Response> {
  const runtimeEnv: AgrisProxyRuntimeEnv = {
    MARKET: serviceBindingPort(gatewayEnv.MARKET),
    CATALOG: serviceBindingPort(gatewayEnv.CATALOG),
  };
  // The cached entrypoint runs the operation uncached here: each case asserts what the public surface adds, and
  // `worker-entrypoints.feature` owns the cache behaviour.
  const cachedAgrisProxy = ({ props }: { readonly props: AgrisProxyExecutionProps }) => ({
    fetch: () => executeAgrisProxy(runtimeEnv, props),
  });
  const result: unknown = await withExports({ CachedAgrisProxy: cachedAgrisProxy }, () =>
    publicAgrisProxyWorker.fetch(request, gatewayEnv, createExecutionContext()),
  );
  if (!(result instanceof Response)) throw new TypeError("The public gateway did not return a Response");
  return result;
}

function marketItemPost(): Request {
  return new Request(`${ORIGIN}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify({ query: MARKET_ITEM_QUERY, variables: MARKET_ITEM_VARIABLES }),
  });
}

function requestEveryPath(gatewayEnv: PublicGatewayEnv): Promise<Response[]> {
  return Promise.all(
    [`${ORIGIN}/health`, `${ORIGIN}/`, `${ORIGIN}/graphql`].map((url) =>
      fetchPublicGateway(new Request(url), gatewayEnv),
    ),
  );
}

function limiter(success: boolean): RateLimitPort {
  return { limit: () => Promise.resolve({ success }) };
}

function staticSite(): NonNullable<PublicGatewayEnv["ASSETS"]> {
  return {
    fetch: (request) =>
      Promise.resolve(
        new URL(request.url).pathname === "/"
          ? new Response(SITE_HOME, { headers: { "Content-Type": "text/html" } })
          : new Response("Not found", { status: 404 }),
      ),
  };
}

async function assertRateLimited(response: Response, scope: "client" | "global"): Promise<void> {
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  const body = v.parse(rateLimitedBodySchema, await response.json());
  assert.equal(body.errors[0].extensions.scope, scope);
  assert.ok(body.errors[0].message.includes(DEPLOY_GUIDE_URL), body.errors[0].message);
}

async function readPearlAbyssObservation(): Promise<{ readonly distinct: number; readonly total: number }> {
  // SAFETY: The Vitest Miniflare configuration owns and installs the PA_OBSERVER service binding for this test runtime.
  const observer = (env as Cloudflare.Env & { readonly PA_OBSERVER: Fetcher }).PA_OBSERVER;
  const response = await observer.fetch("https://pa-observer.internal/");
  assert.equal(response.status, 200);
  return v.parse(pearlAbyssObservationSchema, await response.json());
}

function requiredResponses(world: PublicGatewayWorld): readonly Response[] {
  assert.ok(world.responses);
  return world.responses;
}

function requiredResponse(world: PublicGatewayWorld, index: number): Response {
  const response = world.responses?.[index];
  assert.ok(response);
  return response;
}
