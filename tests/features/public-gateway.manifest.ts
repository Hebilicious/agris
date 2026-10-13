import assert from "node:assert/strict";
import { env, createExecutionContext } from "cloudflare:test";
import { withExports } from "cloudflare:workers";
import { buildClientSchema, buildSchema, getIntrospectionQuery, type IntrospectionQuery } from "graphql";
import { Schema } from "effect";

import websiteFavicon from "../../website/public/favicon.svg?raw";
import { clientSchemaSdl } from "../../tools/schema/artifacts/gateway-schemas.ts";
import { schemaElementDescriptions, undocumentedSchemaElements } from "../../tools/schema/src/schema-documentation.ts";
import {
  executeAgrisProxy,
  serviceBindingPort,
  type AgrisProxyExecutionProps,
  type AgrisProxyRuntimeEnv,
} from "../../apps/gateway/src/index.ts";
import { publicAgrisProxyWorker, type PublicGatewayEnv, type RateLimitPort } from "../../apps/gateway/src/public.ts";

import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";
import { STRICT } from "../support/schema.ts";

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

const decodeCatalogEntitiesRequest = Schema.decodeUnknownSync(
  Schema.Struct({
    variables: Schema.Struct({
      representations: Schema.Array(
        Schema.Struct({ __typename: Schema.Literal("Item"), id: Schema.String, locale: Schema.String }),
      ),
    }),
  }),
);
const decodeMarketItemBody = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      market: Schema.Struct({
        items: Schema.Array(
          Schema.Struct({
            item: Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
            basePrice: Schema.Number,
          }),
        ),
      }),
    }),
  }),
);
const decodeRateLimitedBody = Schema.decodeUnknownSync(
  Schema.Struct({
    errors: Schema.Tuple([
      Schema.Struct({
        message: Schema.String,
        extensions: Schema.Struct({
          code: Schema.Literal("RATE_LIMITED"),
          scope: Schema.Literals(["client", "global"]),
        }),
      }),
    ]),
  }),
  STRICT,
);
const decodePearlAbyssObservation = Schema.decodeUnknownSync(
  Schema.Struct({ distinct: Schema.Number, total: Schema.Number }),
  STRICT,
);
const decodeOneErrorBody = Schema.decodeUnknownSync(
  Schema.Struct({ errors: Schema.Tuple([Schema.Struct({ message: Schema.String })]) }),
);

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
      const parsed = decodeMarketItemBody(body);
      assert.deepEqual(
        parsed.data.market.items.map(({ item, basePrice }) => ({ id: item.id, name: item.name, basePrice })),
        [{ id: "10006", name: "Catalog item 10006", basePrice: 377_000 }],
      );
    }
  }),
  step("a browser requests the same market item by persisted id", noStepArguments, async (world) => {
    const variables = encodeURIComponent(JSON.stringify(MARKET_ITEM_VARIABLES));
    const request = new Request(`${ORIGIN}/graphql?id=${PERSISTED_OPERATION_ID}&variables=${variables}`, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    const response = await fetchPublicGateway(request, publicEnv());
    world.responses = [response];
    world.bodies = [await response.clone().text()];
  }),
  step("the gateway answers with the item's JSON data rather than GraphiQL", noStepArguments, async (world) => {
    const response = requiredResponse(world, 0);
    assert.equal(response.status, 200, String(world.bodies?.[0]));
    assert.doesNotMatch(response.headers.get("Content-Type") ?? "", /text\/html/u);
    const parsed = decodeMarketItemBody(await response.json());
    assert.deepEqual(
      parsed.data.market.items.map(({ item }) => item.id),
      ["10006"],
    );
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
  step(
    "one caller sends three market item requests to a public gateway that binds no rate limiter",
    noStepArguments,
    async (world) => {
      const gatewayEnv = publicEnv();
      assert.equal(gatewayEnv.CLIENT_RATE_LIMITER, undefined);
      assert.equal(gatewayEnv.GLOBAL_RATE_LIMITER, undefined);
      const responses: Response[] = [];
      for (let request = 0; request < 3; request += 1) {
        responses.push(await fetchPublicGateway(marketItemPost(), gatewayEnv));
      }
      world.responses = responses;
      world.bodies = await Promise.all(responses.map((response) => response.clone().json()));
    },
  ),
  step("every request returns the Pearl Abyss item", noStepArguments, (world) => {
    assert.deepEqual(
      requiredResponses(world).map((response) => response.status),
      [200, 200, 200],
      JSON.stringify(world.bodies),
    );
    for (const body of world.bodies ?? []) {
      assert.deepEqual(
        decodeMarketItemBody(body).data.market.items.map(({ basePrice }) => basePrice),
        [377_000],
      );
    }
  }),
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
    const body = decodeOneErrorBody(await home.json(), STRICT);
    assert.match(body.errors[0].message, /\/graphql/u);
  }),
  step("a browser opens a link to the GraphQL path that carries a query", noStepArguments, async (world) => {
    const link = new Request(`${ORIGIN}/graphql?query=${encodeURIComponent("{ __typename }")}`, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    world.responses = [await fetchPublicGateway(link, publicEnv())];
  }),
  step("the gateway does not replace the link's query with its example", noStepArguments, async (world) => {
    const page = requiredResponse(world, 0);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("Content-Type") ?? "", /^text\/html/u);
    // GraphiQL reads the link's `?query=` itself; a `query` option on the page would replace it.
    assert.doesNotMatch(await page.text(), /"query":/u);
  }),
  step("a browser opens the GraphQL path", noStepArguments, async (world) => {
    world.responses = [await fetchPublicGateway(browserGraphqlRequest(), publicEnv())];
  }),
  step("the gateway answers with the GraphiQL page, showing Agris's icon", noStepArguments, async (world) => {
    const page = requiredResponse(world, 0);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("Content-Type") ?? "", /^text\/html/u);
    const html = await page.text();
    assert.match(html, /<title>[^<]*GraphiQL[^<]*<\/title>/u);
    assert.match(html, /"endpoint":"\/graphql"/u);
    // The tab shows Agris's icon, the website's own favicon, and no other icon.
    assert.deepEqual(await iconLinksOf(html), [`data:image/svg+xml,${encodeURIComponent(websiteFavicon)}`]);
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
    const body = decodeIntrospectionBody(world.bodies?.[0]);
    assert.equal(body.data.__schema.queryType.name, "Query");
    const typeNames = body.data.__schema.types.map(({ name }) => name);
    for (const name of ["Item", "Market", "MarketRegion"]) assert.ok(typeNames.includes(name), name);
  }),
  step(
    "every type, field, argument, enum value and input field in it carries the client schema's description",
    noStepArguments,
    (world) => {
      const served = buildClientSchema(introspectionResult(world.bodies?.[0]));
      const committed = buildSchema(clientSchemaSdl);
      // Hive Gateway adds its own `@merge` directive, undocumented, to the schema it serves; it is the gateway's, not
      // the client schema's, and GraphiQL lists it apart from the types.
      const isGatewayDirective = (coordinate: string) => coordinate.startsWith("@merge");
      assert.deepEqual(
        undocumentedSchemaElements(served).filter((coordinate) => !isGatewayDirective(coordinate)),
        [],
      );
      const servedDescriptions = [...schemaElementDescriptions(served)].filter(([key]) => !isGatewayDirective(key));
      assert.deepEqual(new Map(servedDescriptions), schemaElementDescriptions(committed));
    },
  ),
  step("a browser opens the GraphQL path on a gateway with GraphiQL disabled", noStepArguments, async (world) => {
    world.responses = [await fetchPublicGateway(browserGraphqlRequest(), publicEnv({ GRAPHIQL: "disabled" }))];
  }),
  step("the gateway answers that a query is required instead of GraphiQL", noStepArguments, async (world) => {
    const response = requiredResponse(world, 0);
    assert.equal(response.status, 400);
    assert.doesNotMatch(response.headers.get("Content-Type") ?? "", /text\/html/u);
    const body = decodeOneErrorBody(await response.json());
    assert.ok(body.errors.length > 0);
  }),
];

const decodeIntrospectionBody = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      __schema: Schema.Struct({
        queryType: Schema.Struct({ name: Schema.String }),
        types: Schema.Array(Schema.Struct({ name: Schema.String })),
      }),
    }),
  }),
);

/* BOUNDARY: The gateway's introspection answer, whole, for `buildClientSchema`. */
function introspectionResult(body: unknown): IntrospectionQuery {
  // The decode proves the answer is an introspection result; it keeps only the parts it names, so the whole `data`
  // is read from the body itself.
  decodeIntrospectionBody(body);
  if (typeof body !== "object" || body === null || !("data" in body)) throw new TypeError("No introspection data");
  // SAFETY: `data` holds a `__schema` the decode accepted, and `buildClientSchema` reads it field by field, throwing on
  // any part it cannot use.
  return body.data as IntrospectionQuery;
}

/** The `href` of every `<link>` whose `rel` names an icon, read by Cloudflare's own HTML parser. */
async function iconLinksOf(html: string): Promise<string[]> {
  const hrefs: string[] = [];
  const rewriter = new HTMLRewriter().on("link", {
    element(link) {
      const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/u);
      if (rel.includes("icon")) hrefs.push(link.getAttribute("href") ?? "");
    },
  });
  await rewriter.transform(new Response(html)).text();
  return hrefs;
}

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
    const { variables } = decodeCatalogEntitiesRequest(await request.json());
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
  const body = decodeRateLimitedBody(await response.json());
  assert.equal(body.errors[0].extensions.scope, scope);
  assert.ok(body.errors[0].message.includes(DEPLOY_GUIDE_URL), body.errors[0].message);
}

async function readPearlAbyssObservation(): Promise<{ readonly distinct: number; readonly total: number }> {
  // SAFETY: The Vitest Miniflare configuration owns and installs the PA_OBSERVER service binding for this test runtime.
  const observer = (env as Cloudflare.Env & { readonly PA_OBSERVER: Fetcher }).PA_OBSERVER;
  const response = await observer.fetch("https://pa-observer.internal/");
  assert.equal(response.status, 200);
  return decodePearlAbyssObservation(await response.json());
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
