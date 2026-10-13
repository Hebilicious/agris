import assert from "node:assert/strict";
import { env, createExecutionContext, evictDurableObject } from "cloudflare:test";
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
import { admissionObjectName } from "../../apps/gateway/src/admission.ts";
import { publicAgrisProxyWorker, type PublicGatewayEnv, type RateLimitPort } from "../../apps/gateway/src/public.ts";

import {
  integerPairStepArguments,
  integerStepArgument,
  noStepArguments,
  step,
  type ExecutableFeatureManifest,
  type StepDefinition,
} from "../support/manifest.ts";
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
  failure?: unknown;
}

const EVICTED_CLIENT = "198.51.100.30";
const RATE_CHANGE_CLIENT = "198.51.100.31";
const PREFLIGHT_CLIENT = "198.51.100.32";

/** A query that never leaves the gateway, so a burst of it spends only the gateway's admission. */
const TYPENAME_QUERY = "{ __typename }";

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
const decodeAdmissionUnavailableBody = Schema.decodeUnknownSync(
  Schema.Struct({
    errors: Schema.Tuple([
      Schema.Struct({
        message: Schema.String,
        extensions: Schema.Struct({ code: Schema.Literal("ADMISSION_UNAVAILABLE") }),
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
  step(
    "a public gateway that admits each client exactly {int} requests a minute",
    integerStepArgument,
    (world, limit) => {
      world.gatewayEnv = exactlyAdmittingEnv({ ADMISSION_CLIENT_REQUESTS: String(limit) });
    },
  ),
  step(
    "a public gateway that admits the whole deployment exactly {int} requests a minute",
    integerStepArgument,
    (world, limit) => {
      world.gatewayEnv = exactlyAdmittingEnv({ ADMISSION_GLOBAL_REQUESTS: String(limit) });
    },
  ),
  step("one client sends {int} requests at once", integerStepArgument, async (world, count) => {
    const gatewayEnv = requiredGatewayEnv(world);
    world.responses = await Promise.all(
      Array.from({ length: count }, () => fetchPublicGateway(typenamePost("198.51.100.20"), gatewayEnv)),
    );
  }),
  step("{int} clients send one request each at once", integerStepArgument, async (world, count) => {
    const gatewayEnv = requiredGatewayEnv(world);
    world.responses = await Promise.all(
      Array.from({ length: count }, (_, client) =>
        fetchPublicGateway(typenamePost(`198.51.100.${100 + client}`), gatewayEnv),
      ),
    );
  }),
  step(
    "two addresses in one IPv6 \\/64 send {int} requests each, one after the other",
    integerStepArgument,
    async (world, count) => {
      const gatewayEnv = requiredGatewayEnv(world);
      const responses: Response[] = [];
      // The same /64, written once compressed and once in full.
      for (const address of ["2001:db8:0:7::1", "2001:0db8:0000:0007:ffff::2"]) {
        for (let request = 0; request < count; request += 1) {
          responses.push(await fetchPublicGateway(typenamePost(address), gatewayEnv));
        }
      }
      world.responses = responses;
    },
  ),
  step(
    "{int} requests are answered and {int} are answered 429 for the client scope with a Retry-After",
    integerPairStepArguments,
    (world, answered, refused) => assertAdmittedAndRefused(world, answered, refused, "client"),
  ),
  step(
    "{int} requests are answered and {int} are answered 429 for the global scope with a Retry-After",
    integerPairStepArguments,
    (world, answered, refused) => assertAdmittedAndRefused(world, answered, refused, "global"),
  ),
  step("one client spends its allowance and its admission object is evicted", noStepArguments, async (world) => {
    const gatewayEnv = requiredGatewayEnv(world);
    await spendAllowance(gatewayEnv, EVICTED_CLIENT, 2);
    // The runtime tears the object down, as it does to an idle one; only what it stored survives.
    await evictDurableObject(admissionNamespace().getByName(admissionObjectName("client", EVICTED_CLIENT)));
    world.responses = [await fetchPublicGateway(typenamePost(EVICTED_CLIENT), gatewayEnv)];
  }),
  step(
    "one client spends its allowance and the deployment raises the limit to {int} requests a minute",
    integerStepArgument,
    async (world, limit) => {
      await spendAllowance(requiredGatewayEnv(world), RATE_CHANGE_CLIENT, 2);
      const raised = exactlyAdmittingEnv({ ADMISSION_CLIENT_REQUESTS: String(limit) });
      world.responses = [await fetchPublicGateway(typenamePost(RATE_CHANGE_CLIENT), raised)];
    },
  ),
  step(
    "the client's next request is answered 429 for the client scope with a Retry-After",
    noStepArguments,
    async (world) => {
      await assertExactlyRefused(requiredResponse(world, 0), "client");
    },
  ),
  step("another client is still answered", noStepArguments, async (world) => {
    const response = await fetchPublicGateway(typenamePost("198.51.100.21"), requiredGatewayEnv(world));
    assert.equal(response.status, 200);
  }),
  step(
    "a caller over the client rate limit requests the health path and the site's home page",
    noStepArguments,
    async (world) => {
      const gatewayEnv = publicEnv({ CLIENT_RATE_LIMITER: limiter(false), ASSETS: staticSite() });
      world.responses = await Promise.all(
        [healthGet("203.0.113.9"), homeGet("203.0.113.9")].map((request) => fetchPublicGateway(request, gatewayEnv)),
      );
    },
  ),
  step("one client sends {int} CORS preflights and then a query", integerStepArgument, async (world, count) => {
    const gatewayEnv = requiredGatewayEnv(world);
    const responses: Response[] = [];
    for (let request = 0; request < count; request += 1) {
      responses.push(await fetchPublicGateway(preflight(PREFLIGHT_CLIENT), gatewayEnv));
    }
    responses.push(await fetchPublicGateway(typenamePost(PREFLIGHT_CLIENT), gatewayEnv));
    world.responses = responses;
  }),
  step(
    "the gateway answers both preflights 204 and the query 429 for the client scope with a Retry-After",
    noStepArguments,
    async (world) => {
      const [first, second, query] = requiredResponses(world);
      assert.ok(first && second && query);
      assert.deepEqual([first.status, second.status], [204, 204]);
      await assertExactlyRefused(query, "client");
    },
  ),
  step("the client sends another CORS preflight", noStepArguments, async (world) => {
    world.responses = [await fetchPublicGateway(preflight(PREFLIGHT_CLIENT), requiredGatewayEnv(world))];
  }),
  step("a caller over the client rate limit sends a CORS preflight", noStepArguments, async (world) => {
    const gatewayEnv = publicEnv({ CLIENT_RATE_LIMITER: limiter(false) });
    world.responses = [await fetchPublicGateway(preflight("203.0.113.9"), gatewayEnv)];
  }),
  step(
    "the gateway answers it 204 allowing GET, POST and OPTIONS, for the browser not to remember",
    noStepArguments,
    (world) => {
      const response = requiredResponse(world, 0);
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
      assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
      assert.match(response.headers.get("Access-Control-Allow-Headers") ?? "", /Content-Type/u);
      // The browser asks again before its next request, so a preflight admitted later is not skipped.
      assert.equal(response.headers.get("Access-Control-Max-Age"), "0");
      assert.equal(response.headers.get("Retry-After"), null);
    },
  ),
  step(
    "the gateway answers each one 429 for the client scope with Retry-After 60 and the deploy guide",
    noStepArguments,
    async (world) => {
      for (const response of requiredResponses(world)) await assertRateLimited(response, "client");
    },
  ),
  step("a caller over its exact client allowance requests the health path", noStepArguments, async (world) => {
    const gatewayEnv = exactlyAdmittingEnv({ ADMISSION_CLIENT_REQUESTS: "1" });
    const first = await fetchPublicGateway(healthGet("203.0.113.10"), gatewayEnv);
    assert.equal(first.status, 200);
    world.responses = [await fetchPublicGateway(healthGet("203.0.113.10"), gatewayEnv)];
  }),
  step("the gateway answers each one 429 for the client scope with a Retry-After", noStepArguments, async (world) => {
    for (const response of requiredResponses(world)) await assertExactlyRefused(response, "client");
  }),
  step("a caller sends a request to a public gateway whose admission object fails", noStepArguments, async (world) => {
    const failing: NonNullable<PublicGatewayEnv["ADMISSION"]> = {
      getByName: () => ({ fetch: () => Promise.reject(new Error("Durable Object overloaded")) }),
    };
    const gatewayEnv = publicEnv({ ADMISSION: failing, ADMISSION_CLIENT_REQUESTS: "3" });
    world.responses = [await fetchPublicGateway(typenamePost("203.0.113.11"), gatewayEnv)];
  }),
  step("the gateway answers 503 with code ADMISSION_UNAVAILABLE and a Retry-After", noStepArguments, async (world) => {
    const response = requiredResponse(world, 0);
    assert.equal(response.status, 503);
    assert.match(response.headers.get("Retry-After") ?? "", /^[1-9][0-9]*$/u);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    decodeAdmissionUnavailableBody(await response.json());
  }),
  step(
    "a caller sends a request to a public gateway that sets an exact limit but binds no admission object",
    noStepArguments,
    async (world) => {
      try {
        world.responses = [
          await fetchPublicGateway(typenamePost("203.0.113.12"), publicEnv({ ADMISSION_CLIENT_REQUESTS: "3" })),
        ];
      } catch (error: unknown) {
        world.failure = error;
      }
    },
  ),
  step("the request fails instead of being admitted", noStepArguments, (world) => {
    assert.ok(world.failure instanceof TypeError, JSON.stringify(world.responses?.map(({ status }) => status)));
    assert.match(world.failure.message, /ADMISSION/u);
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

/** A public gateway bound to the test Worker's real `GatewayAdmission` Durable Object, with the exact limits given. */
function exactlyAdmittingEnv(limits: Partial<PublicGatewayEnv>): PublicGatewayEnv {
  return publicEnv({ ADMISSION: admissionNamespace(), ...limits });
}

/** The test Worker's real `GatewayAdmission` namespace. */
function admissionNamespace(): DurableObjectNamespace {
  // SAFETY: The Vitest Miniflare configuration binds ADMISSION to the gateway's own GatewayAdmission class.
  const admission = (env as Cloudflare.Env & { readonly ADMISSION?: DurableObjectNamespace }).ADMISSION;
  assert.ok(admission, "The test Worker binds no ADMISSION namespace");
  return admission;
}

/** Send `count` requests from one client, one after the other, and check that each was admitted. */
async function spendAllowance(gatewayEnv: PublicGatewayEnv, clientAddress: string, count: number): Promise<void> {
  for (let request = 0; request < count; request += 1) {
    const response = await fetchPublicGateway(typenamePost(clientAddress), gatewayEnv);
    assert.equal(response.status, 200);
  }
}

function requiredGatewayEnv(world: PublicGatewayWorld): PublicGatewayEnv {
  assert.ok(world.gatewayEnv);
  return world.gatewayEnv;
}

function typenamePost(clientAddress: string): Request {
  return new Request(`${ORIGIN}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientAddress },
    body: JSON.stringify({ query: TYPENAME_QUERY }),
  });
}

function healthGet(clientAddress: string): Request {
  return new Request(`${ORIGIN}/health`, { headers: { "CF-Connecting-IP": clientAddress } });
}

function homeGet(clientAddress: string): Request {
  return new Request(`${ORIGIN}/`, { headers: { "CF-Connecting-IP": clientAddress } });
}

function preflight(clientAddress: string): Request {
  return new Request(`${ORIGIN}/graphql`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://elsewhere.example",
      "Access-Control-Request-Method": "POST",
      "CF-Connecting-IP": clientAddress,
    },
  });
}

async function assertAdmittedAndRefused(
  world: PublicGatewayWorld,
  answered: number,
  refused: number,
  scope: "client" | "global",
): Promise<void> {
  const responses = requiredResponses(world);
  const statuses = responses.map((response) => response.status);
  assert.equal(statuses.filter((status) => status === 200).length, answered, JSON.stringify(statuses));
  assert.equal(statuses.filter((status) => status === 429).length, refused, JSON.stringify(statuses));
  for (const response of responses.filter(({ status }) => status === 429)) await assertExactlyRefused(response, scope);
}

/** An exact refusal: a 429 whose Retry-After is the whole seconds until the bucket admits one more request. */
async function assertExactlyRefused(response: Response, scope: "client" | "global"): Promise<void> {
  assert.equal(response.status, 429);
  const retryAfter = response.headers.get("Retry-After") ?? "";
  assert.match(retryAfter, /^[1-9][0-9]*$/u);
  assert.ok(Number(retryAfter) <= 60, retryAfter);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  const body = decodeRateLimitedBody(await response.json());
  assert.equal(body.errors[0].extensions.scope, scope);
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
