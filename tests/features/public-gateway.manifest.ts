import assert from "node:assert/strict";
import { env, createExecutionContext, evictDurableObject } from "cloudflare:test";
import { withExports } from "cloudflare:workers";
import { buildClientSchema, buildSchema, getIntrospectionQuery, type IntrospectionQuery } from "graphql";
import { Schema } from "effect";

import websiteFavicon from "../../website/public/favicon.svg?raw";
import { clientSchemaSdl } from "../../tools/schema/artifacts/gateway-schemas.ts";
import { schemaElementDescriptions, undocumentedSchemaElements } from "../../tools/schema/src/schema-documentation.ts";
import {
  executeCachedAgrisProxy,
  type AgrisProxyExecutionProps,
  type BudgetedSubgraphServiceBinding,
} from "../../apps/gateway/src/index.ts";
import { admissionObjectName, type AdmissionNamespacePort } from "../../apps/gateway/src/admission.ts";
import { graphiqlContentSecurityPolicy, RenderedPages } from "../../apps/gateway/src/graphiql-page.ts";
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
  /** The edge cache in front of the cached execution, when the case has one. */
  edge?: EdgeCache;
  /** The admission namespace the case's gateway binds, counting the requests it receives. */
  admission?: CountingAdmission;
  itemIds?: readonly string[];
  /** The market subgraph calls the case's execution made, when it counts them. */
  marketCalls?: readonly unknown[];
}

/** Workers Cache in front of the cached execution, keyed as it keys: by the cache key request's URL. */
interface EdgeCache {
  readonly entries: Map<string, Response>;
  /** Whether every stored answer is past its freshness window, so a request refreshes it. */
  expired: boolean;
}

/** An admission namespace that counts every request its objects receive. */
interface CountingAdmission {
  readonly namespace: AdmissionNamespacePort;
  requests: number;
}

const CACHE_HIT_CLIENT = "198.51.100.25";
const TWO_CALLS_CLIENT = "198.51.100.26";
const CATALOG_ONLY_CLIENT = "198.51.100.27";
const BURST_CLIENT = "198.51.100.20";
const UNCACHED_CLIENT = "198.51.100.28";
const STALE_CLIENT = "198.51.100.29";
const EVICTED_CLIENT = "198.51.100.30";
const RATE_CHANGE_CLIENT = "198.51.100.31";
const GRAPHIQL_RELEASE_URL = "https://unpkg.com/@graphql-yoga/graphiql@5.0.0/dist/";
/** A page whose inline scripts are written every way a template may write them, beside an external script. */
const ATTRIBUTED_SCRIPTS_PAGE = [
  "<!doctype html><title>GraphiQL</title>",
  `<script type="module" src="${GRAPHIQL_RELEASE_URL}graphiql.js"></script>`,
  "<script>globalThis.plain = 1;</script>",
  '<script type="module">globalThis.module = 2;</script>',
  "<SCRIPT nonce=x data-src=none>globalThis.attributed = 3;</SCRIPT>",
].join("\n");

/** Market item IDs no other case asks for, so each query is a cache miss and a Pearl Abyss read. */
let lastMarketItem = 31_000;
function nextMarketItem(): string {
  lastMarketItem += 1;
  return String(lastMarketItem);
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
const decodeErrorCodesBody = Schema.decodeUnknownSync(
  Schema.Struct({
    errors: Schema.Array(Schema.Struct({ extensions: Schema.Struct({ code: Schema.String }) })),
  }),
);
const decodeCatalogItemBody = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Struct({ item: Schema.Struct({ name: Schema.String }) }) }),
);
const decodeTwoMarketCallsBody = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      item: Schema.Struct({ marketSummary: Schema.Struct({ basePrice: Schema.Number }) }),
      market: Schema.Struct({ items: Schema.Array(Schema.Struct({ basePrice: Schema.Number })) }),
    }),
  }),
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
    world.bodies = [html];
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
    "a public gateway behind an edge cache that admits each client exactly {int} market execution(s) a minute",
    integerStepArgument,
    (world, limit) => {
      world.admission = countingAdmission(admissionNamespace());
      world.edge = { entries: new Map(), expired: false };
      world.gatewayEnv = marketAdmittingEnv(world.admission, limit);
    },
  ),
  step(
    "a public gateway that stores nothing and admits each client exactly {int} market execution(s) a minute",
    integerStepArgument,
    (world, limit) => {
      world.admission = countingAdmission(admissionNamespace());
      world.gatewayEnv = Object.assign(marketAdmittingEnv(world.admission, limit), { CACHE_ENABLED: "false" });
    },
  ),
  step("one client asks for the same market item twice", noStepArguments, async (world) => {
    const item = nextMarketItem();
    world.responses = [
      await fetchWorld(world, marketItemQuery(CACHE_HIT_CLIENT, item)),
      await fetchWorld(world, marketItemQuery(CACHE_HIT_CLIENT, item)),
    ];
    world.bodies = await Promise.all(requiredResponses(world).map((response) => response.clone().json()));
  }),
  step(
    "the first answer is a cache miss and the second a cache hit, both with the Pearl Abyss item",
    noStepArguments,
    (world) => {
      const responses = requiredResponses(world);
      assert.deepEqual(
        responses.map((response) => response.status),
        [200, 200],
        JSON.stringify(world.bodies),
      );
      assert.deepEqual(
        responses.map((response) => response.headers.get("Cf-Cache-Status")),
        ["MISS", "HIT"],
      );
      for (const body of world.bodies ?? []) {
        assert.deepEqual(
          decodeMarketItemBody(body).data.market.items.map(({ basePrice }) => basePrice),
          [377_000],
        );
      }
    },
  ),
  step("the admission objects were asked {int} time(s)", integerStepArgument, (world, count) => {
    assert.equal(requiredAdmission(world).requests, count);
  }),
  step(
    "one client asks in one query for an NA market item and for a catalog item's EU market summary",
    noStepArguments,
    async (world) => {
      const query = `{ item(id: "${nextMarketItem()}") { name marketSummary(region: EU) { basePrice } } market(region: NA) { items(ids: ["${nextMarketItem()}"]) { basePrice } } }`;
      const market = countingMarket(requiredGatewayEnv(world).MARKET);
      world.gatewayEnv = { ...requiredGatewayEnv(world), MARKET: market.binding };
      const response = await fetchWorld(world, graphqlPost(TWO_CALLS_CLIENT, query));
      world.marketCalls = market.calls;
      world.responses = [response];
      world.bodies = [await response.clone().json()];
    },
  ),
  step("the answer carries the market item and the market summary", noStepArguments, (world) => {
    assert.equal(requiredResponse(world, 0).status, 200, JSON.stringify(world.bodies));
    // The market item is a root field; the summary needs the catalog's item first, so it is a second market call.
    assert.equal(world.marketCalls?.length, 2);
    const body = decodeTwoMarketCallsBody(world.bodies?.[0]);
    assert.equal(body.data.item.marketSummary.basePrice, 377_000);
    assert.deepEqual(
      body.data.market.items.map(({ basePrice }) => basePrice),
      [377_000],
    );
  }),
  step(
    "one client asks for the names of {int} different items, one query each",
    integerStepArgument,
    async (world, count) => {
      const responses: Response[] = [];
      const ids: string[] = [];
      for (let query = 0; query < count; query += 1) {
        const id = nextMarketItem();
        ids.push(id);
        responses.push(await fetchWorld(world, graphqlPost(CATALOG_ONLY_CLIENT, `{ item(id: "${id}") { name } }`)));
      }
      world.responses = responses;
      world.bodies = await Promise.all(responses.map((response) => response.clone().json()));
      world.itemIds = ids;
    },
  ),
  step("every answer is the item's catalog name", noStepArguments, (world) => {
    assert.deepEqual(
      requiredResponses(world).map((response) => response.status),
      (world.itemIds ?? []).map(() => 200),
      JSON.stringify(world.bodies),
    );
    assert.deepEqual(
      (world.bodies ?? []).map((body) => decodeCatalogItemBody(body).data.item.name),
      (world.itemIds ?? []).map((id) => `Catalog item ${id}`),
    );
  }),
  step(
    "one client sends {int} queries for different market items at once",
    integerStepArgument,
    async (world, count) => {
      world.responses = await Promise.all(
        Array.from({ length: count }, () => fetchWorld(world, marketItemQuery(BURST_CLIENT, nextMarketItem()))),
      );
    },
  ),
  step(
    "one client sends {int} queries for different market items, one after the other",
    integerStepArgument,
    async (world, count) => {
      const responses: Response[] = [];
      for (let query = 0; query < count; query += 1) {
        responses.push(await fetchWorld(world, marketItemQuery(UNCACHED_CLIENT, nextMarketItem())));
      }
      world.responses = responses;
    },
  ),
  step(
    "{int} queries are answered and {int} is/are answered 429 RATE_LIMITED with a Retry-After",
    integerPairStepArguments,
    async (world, answered, refused) => {
      const responses = requiredResponses(world);
      const statuses = responses.map((response) => response.status);
      assert.equal(statuses.filter((status) => status === 200).length, answered, JSON.stringify(statuses));
      assert.equal(statuses.filter((status) => status === 429).length, refused, JSON.stringify(statuses));
      for (const response of responses.filter(({ status }) => status === 429)) await assertMarketRefused(response);
    },
  ),
  step("another client's market query is still answered", noStepArguments, async (world) => {
    const response = await fetchWorld(world, marketItemQuery("198.51.100.21", nextMarketItem()));
    assert.equal(response.status, 200);
  }),
  step(
    "one client's market item answer is cached and expires, and the client asks for it again",
    noStepArguments,
    async (world) => {
      const item = nextMarketItem();
      const first = await fetchWorld(world, marketItemQuery(STALE_CLIENT, item));
      assert.equal(first.status, 200);
      requiredEdge(world).expired = true;
      const response = await fetchWorld(world, marketItemQuery(STALE_CLIENT, item));
      world.responses = [response];
      world.bodies = [await response.clone().json()];
    },
  ),
  step(
    "the gateway answers 200 with the cached market item, served stale because its refresh failed",
    noStepArguments,
    (world) => {
      const response = requiredResponse(world, 0);
      assert.equal(response.status, 200, JSON.stringify(world.bodies));
      assert.equal(response.headers.get("Cf-Cache-Status"), "STALE");
      assert.equal(response.headers.get("X-Central-Market-Source"), "cache-stale");
      assert.deepEqual(
        decodeMarketItemBody(world.bodies?.[0]).data.market.items.map(({ basePrice }) => basePrice),
        [377_000],
      );
      assert.equal(requiredAdmission(world).requests, 2);
    },
  ),
  step("the client asks for a market item the edge has never stored", noStepArguments, async (world) => {
    world.responses = [await fetchWorld(world, marketItemQuery(STALE_CLIENT, nextMarketItem()))];
  }),
  step("the query is answered 429 RATE_LIMITED with a Retry-After", noStepArguments, async (world) => {
    await assertMarketRefused(requiredResponse(world, 0));
  }),
  step("one client spends its allowance and its admission object is evicted", noStepArguments, async (world) => {
    await spendAllowance(world, EVICTED_CLIENT, 2);
    // The runtime tears the object down, as it does to an idle one; only what it stored survives.
    await evictDurableObject(admissionNamespace().getByName(admissionObjectName(EVICTED_CLIENT)));
    world.responses = [await fetchWorld(world, marketItemQuery(EVICTED_CLIENT, nextMarketItem()))];
  }),
  step(
    "one client spends its allowance and the deployment raises the limit to {int} market executions a minute",
    integerStepArgument,
    async (world, limit) => {
      await spendAllowance(world, RATE_CHANGE_CLIENT, 2);
      world.gatewayEnv = marketAdmittingEnv(requiredAdmission(world), limit);
      world.responses = [await fetchWorld(world, marketItemQuery(RATE_CHANGE_CLIENT, nextMarketItem()))];
    },
  ),
  step(
    "the client's next market query is answered 429 RATE_LIMITED with a Retry-After",
    noStepArguments,
    async (world) => {
      await assertMarketRefused(requiredResponse(world, 0));
    },
  ),
  step(
    "two addresses in one IPv6 \\/64 send {int} market queries each, one after the other",
    integerStepArgument,
    async (world, count) => {
      const responses: Response[] = [];
      // The same /64, written once compressed and once in full.
      for (const address of ["2001:db8:0:7::1", "2001:0db8:0000:0007:ffff::2"]) {
        for (let query = 0; query < count; query += 1) {
          responses.push(await fetchWorld(world, marketItemQuery(address, nextMarketItem())));
        }
      }
      world.responses = responses;
    },
  ),
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
  step(
    "the gateway answers each one 429 for the client scope with Retry-After 60 and the deploy guide",
    noStepArguments,
    async (world) => {
      for (const response of requiredResponses(world)) await assertRateLimited(response, "client");
    },
  ),
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
    "a caller within the client rate limit requests the health path, a CORS preflight and GraphiQL on a gateway that admits market executions exactly",
    noStepArguments,
    async (world) => {
      world.admission = countingAdmission(admissionNamespace());
      const gatewayEnv = { ...marketAdmittingEnv(world.admission, 1), CLIENT_RATE_LIMITER: limiter(true) };
      const graphiql = new Request(`${ORIGIN}/graphql`, {
        headers: { Accept: "text/html,application/xhtml+xml", "CF-Connecting-IP": "203.0.113.13" },
      });
      world.responses = [
        await fetchPublicGateway(healthGet("203.0.113.13"), gatewayEnv),
        await fetchPublicGateway(preflight("203.0.113.13"), gatewayEnv),
        await fetchPublicGateway(graphiql, gatewayEnv),
      ];
    },
  ),
  step("each one is answered and the admission objects were asked 0 times", noStepArguments, (world) => {
    assert.deepEqual(
      requiredResponses(world).map((response) => response.status),
      [200, 204, 200],
    );
    assert.equal(requiredAdmission(world).requests, 0);
  }),
  step(
    "a caller sends a market query to a public gateway whose admission object fails",
    noStepArguments,
    async (world) => {
      const failing: NonNullable<PublicGatewayEnv["ADMISSION"]> = {
        getByName: () => ({ fetch: () => Promise.reject(new Error("Durable Object overloaded")) }),
      };
      const gatewayEnv = publicEnv({ ADMISSION: failing, MARKET_CLIENT_LIMIT_REQUESTS: "3" });
      world.responses = [await fetchPublicGateway(marketItemQuery("203.0.113.11", nextMarketItem()), gatewayEnv)];
    },
  ),
  step("the query is answered 429 RATE_LIMITED with Retry-After 5", noStepArguments, async (world) => {
    const response = requiredResponse(world, 0);
    assert.equal(response.headers.get("Retry-After"), "5");
    await assertMarketRefused(response);
  }),
  step(
    "a caller sends a request to a public gateway that sets an exact market limit but binds no admission object",
    noStepArguments,
    async (world) => {
      try {
        world.responses = [
          await fetchPublicGateway(
            marketItemQuery("203.0.113.12", nextMarketItem()),
            publicEnv({ MARKET_CLIENT_LIMIT_REQUESTS: "3" }),
          ),
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
  step(
    "the page may run only its own scripts and the pinned GraphiQL release, and no other site may frame it",
    noStepArguments,
    async (world) => {
      const page = requiredResponse(world, 0);
      const policy = contentSecurityPolicy(page.headers.get("Content-Security-Policy"));
      for (const directive of ["default-src", "frame-ancestors", "base-uri", "object-src", "form-action"]) {
        assert.deepEqual(policy.get(directive), ["'none'"], directive);
      }
      const scripts = policy.get("script-src") ?? [];
      assert.ok(!scripts.includes("'unsafe-inline'") && !scripts.includes("'unsafe-eval'"), scripts.join(" "));
      // Every inline script on the page is allowed by its hash, and every other script source is the pinned release.
      const html = world.bodies?.[0];
      assert.ok(typeof html === "string", "The GraphiQL page was not read");
      for (const hash of await inlineScriptHashesOf(html)) assert.ok(scripts.includes(hash), `${hash} is not allowed`);
      for (const source of scripts.filter((value) => !value.startsWith("'sha256-"))) {
        assert.match(source, /^https:\/\/unpkg\.com\/@graphql-yoga\/graphiql@[0-9]+\.[0-9]+\.[0-9]+\/dist\/$/u);
      }
      const allowed = [...scripts, ...(policy.get("style-src") ?? [])];
      for (const source of await externalSourcesOf(html)) {
        assert.ok(
          allowed.some((prefix) => prefix.startsWith("https://") && source.startsWith(prefix)),
          `${source} is not allowed`,
        );
      }
      assert.equal(page.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(page.headers.get("Referrer-Policy"), "no-referrer");
      assert.equal(page.headers.get("X-Frame-Options"), "DENY");
    },
  ),
  step(
    "the GraphiQL policy is made for a page whose inline scripts carry attributes beside an external script",
    noStepArguments,
    async (world) => {
      const policy = await graphiqlContentSecurityPolicy(ATTRIBUTED_SCRIPTS_PAGE);
      world.bodies = [ATTRIBUTED_SCRIPTS_PAGE, policy];
    },
  ),
  step(
    "every inline script on that page has its hash in the policy, and nothing else is hashed",
    noStepArguments,
    async (world) => {
      const [html, header] = world.bodies ?? [];
      assert.ok(typeof html === "string" && typeof header === "string");
      const hashes = (contentSecurityPolicy(header).get("script-src") ?? []).filter((source) =>
        source.startsWith("'sha256-"),
      );
      const inline = await inlineScriptHashesOf(html);
      assert.equal(inline.length, 3);
      assert.deepEqual([...hashes].sort(), [...inline].sort());
    },
  ),
  step("a GraphiQL page fails to render once and is then requested again", noStepArguments, async (world) => {
    let renders = 0;
    const pages = new RenderedPages(async (key: string) => {
      renders += 1;
      if (renders === 1) throw new TypeError(`Rendering ${key} failed`);
      return { html: `<title>${key}</title>`, contentSecurityPolicy: "default-src 'none'" };
    });
    const first = await pages.get("page").then(
      () => "rendered",
      (error: unknown) => String(error),
    );
    // Let the failed render settle, as a later request in the same isolate would.
    await Promise.resolve();
    const second = await pages.get("page");
    world.bodies = [first, second.html, renders];
  }),
  step("the second request renders the page afresh and gets it", noStepArguments, (world) => {
    assert.deepEqual(world.bodies, ["TypeError: Rendering page failed", "<title>page</title>", 2]);
  }),
  step("every response forbids content sniffing and sends no referrer", noStepArguments, (world) => {
    for (const response of requiredResponses(world)) {
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    }
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
    const body: unknown = await request.json();
    const rootItem = rootItemRequestOf(body);
    if (rootItem !== undefined) {
      return Response.json({
        data: { item: { __typename: "Item", id: rootItem, locale: "EN", name: `Catalog item ${rootItem}` } },
      });
    }
    const { variables } = decodeCatalogEntitiesRequest(body);
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

/* BOUNDARY: A catalog request for the root `item` field, which names its item ID in the document; else `undefined`. */
function rootItemRequestOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("query" in body) || typeof body.query !== "string") {
    return undefined;
  }
  if (body.query.includes("_entities")) return undefined;
  // Hive Gateway passes the ID as a variable or writes it into the document.
  const variables: unknown = "variables" in body ? body.variables : undefined;
  const fromVariables =
    typeof variables === "object" && variables !== null
      ? Object.values(variables).find((value): value is string => typeof value === "string" && /^\d+$/u.test(value))
      : undefined;
  return fromVariables ?? /"(\d+)"/u.exec(body.query)?.[1];
}

/**
 * The public gateway with the cached entrypoint's own miss execution behind it. Without an `edge`, every storable
 * operation runs uncached: those cases assert what the public surface adds, and `worker-entrypoints.feature` owns the
 * cache behaviour. With one, the edge answers as Workers Cache does: a fresh stored answer is a HIT; otherwise the
 * operation executes, and when a stored answer exists and the execution failed with a 5xx (`stale-if-error`), the
 * stored answer is served STALE.
 */
async function fetchPublicGateway(request: Request, gatewayEnv: PublicGatewayEnv, edge?: EdgeCache): Promise<Response> {
  const cachedAgrisProxy = ({ props }: { readonly props: AgrisProxyExecutionProps }) => ({
    fetch: (cacheKey: Request) =>
      edgeCached(edge, cacheKey, () => executeCachedAgrisProxy(gatewayEnv, props, cacheKey)),
  });
  const result: unknown = await withExports({ CachedAgrisProxy: cachedAgrisProxy }, () =>
    publicAgrisProxyWorker.fetch(request, gatewayEnv, createExecutionContext()),
  );
  if (!(result instanceof Response)) throw new TypeError("The public gateway did not return a Response");
  return result;
}

async function edgeCached(
  edge: EdgeCache | undefined,
  cacheKey: Request,
  execute: () => Promise<Response>,
): Promise<Response> {
  if (edge === undefined) return execute();
  const stored = edge.entries.get(cacheKey.url);
  if (stored !== undefined && !edge.expired) return withCacheStatus(stored.clone(), "HIT");
  const response = await execute();
  if (stored !== undefined && response.status >= 500) return withCacheStatus(stored.clone(), "STALE");
  if (response.ok && response.headers.get("Cache-Control") !== "no-store") {
    edge.entries.set(cacheKey.url, response.clone());
    edge.expired = false;
  }
  return withCacheStatus(response, stored === undefined ? "MISS" : "EXPIRED");
}

function withCacheStatus(response: Response, status: string): Response {
  const headers = new Headers(response.headers);
  headers.set("cf-cache-status", status);
  return new Response(response.body, { status: response.status, headers });
}

/** The case's gateway, behind the case's edge cache when it has one. */
function fetchWorld(world: PublicGatewayWorld, request: Request): Promise<Response> {
  return fetchPublicGateway(request, requiredGatewayEnv(world), world.edge);
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

/** A public gateway whose executions admit each client's market calls exactly `limit` times a minute. */
function marketAdmittingEnv(admission: CountingAdmission, limit: number): PublicGatewayEnv {
  return publicEnv({ ADMISSION: admission.namespace, MARKET_CLIENT_LIMIT_REQUESTS: String(limit) });
}

/** The test Worker's real `GatewayAdmission` namespace. */
function admissionNamespace(): DurableObjectNamespace {
  // SAFETY: The Vitest Miniflare configuration binds ADMISSION to the gateway's own GatewayAdmission class.
  const admission = (env as Cloudflare.Env & { readonly ADMISSION?: DurableObjectNamespace }).ADMISSION;
  assert.ok(admission, "The test Worker binds no ADMISSION namespace");
  return admission;
}

/** The market Worker's binding, recording every subgraph call made through it. */
function countingMarket(inner: Fetcher): { readonly binding: Fetcher; readonly calls: unknown[] } {
  const calls: unknown[] = [];
  // SAFETY: The gateway reaches the market only through `fetchWithBudget` (`serviceBindingPort`), which this forwards.
  const budgeted = inner as unknown as BudgetedSubgraphServiceBinding;
  const binding = {
    fetchWithBudget: (...call: Parameters<BudgetedSubgraphServiceBinding["fetchWithBudget"]>) => {
      calls.push(call);
      return budgeted.fetchWithBudget(...call);
    },
  };
  // SAFETY: As above, the one method the gateway calls on a market binding is the one this object has.
  return { binding: binding as unknown as Fetcher, calls };
}

/** `inner`, counting every request its objects receive. */
function countingAdmission(inner: AdmissionNamespacePort): CountingAdmission {
  const counting: CountingAdmission = {
    requests: 0,
    namespace: {
      getByName: (name) => {
        const stub = inner.getByName(name);
        return {
          fetch: (request) => {
            counting.requests += 1;
            return stub.fetch(request);
          },
        };
      },
    },
  };
  return counting;
}

/** Send `count` queries for different market items from one client, one after the other, each admitted. */
async function spendAllowance(world: PublicGatewayWorld, clientAddress: string, count: number): Promise<void> {
  for (let query = 0; query < count; query += 1) {
    const response = await fetchWorld(world, marketItemQuery(clientAddress, nextMarketItem()));
    assert.equal(response.status, 200);
  }
}

function requiredAdmission(world: PublicGatewayWorld): CountingAdmission {
  assert.ok(world.admission);
  return world.admission;
}

function requiredEdge(world: PublicGatewayWorld): EdgeCache {
  assert.ok(world.edge);
  return world.edge;
}

function requiredGatewayEnv(world: PublicGatewayWorld): PublicGatewayEnv {
  assert.ok(world.gatewayEnv);
  return world.gatewayEnv;
}

function graphqlPost(clientAddress: string, query: string): Request {
  return new Request(`${ORIGIN}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientAddress },
    body: JSON.stringify({ query }),
  });
}

/** A cacheable query for one NA market item, which reaches Pearl Abyss on a miss. */
function marketItemQuery(clientAddress: string, itemId: string): Request {
  return graphqlPost(
    clientAddress,
    `{ market(region: NA) { items(ids: ["${itemId}"]) { item { id name } basePrice } } }`,
  );
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

/**
 * A market call the client's admission refused: a 429 whose Retry-After is the whole seconds until the bucket admits
 * one more, with the market's own `RATE_LIMITED` error and none of the gateway's internal headers.
 */
async function assertMarketRefused(response: Response): Promise<void> {
  assert.equal(response.status, 429);
  const retryAfter = response.headers.get("Retry-After") ?? "";
  assert.match(retryAfter, /^[1-9][0-9]*$/u);
  assert.ok(Number(retryAfter) <= 60, retryAfter);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("X-Agris-Upstream-Outcome"), null);
  const body = decodeErrorCodesBody(await response.json());
  assert.ok(
    body.errors.some(({ extensions }) => extensions.code === "RATE_LIMITED"),
    JSON.stringify(body),
  );
}

/** A Content-Security-Policy header as its directives, each with its sources. */
function contentSecurityPolicy(header: string | null): ReadonlyMap<string, readonly string[]> {
  assert.ok(header, "The response has no Content-Security-Policy");
  const directives = new Map<string, readonly string[]>();
  for (const directive of header.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/u);
    if (name !== undefined && name !== "") directives.set(name, sources);
  }
  return directives;
}

/** The CSP hash source of every inline `<script>` on the page, read by Cloudflare's own HTML parser. */
async function inlineScriptHashesOf(html: string): Promise<string[]> {
  const scripts: string[] = [];
  let inline = false;
  const rewriter = new HTMLRewriter().on("script", {
    element(script) {
      inline = script.getAttribute("src") === null;
      if (inline) scripts.push("");
    },
    text(chunk) {
      if (inline) scripts[scripts.length - 1] += chunk.text;
    },
  });
  await rewriter.transform(new Response(html)).text();
  return Promise.all(
    scripts.map(async (script) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
      return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
    }),
  );
}

/** The `src` of every external script and the `href` of every stylesheet on the page. */
async function externalSourcesOf(html: string): Promise<string[]> {
  const sources: string[] = [];
  const rewriter = new HTMLRewriter()
    .on("script[src]", {
      element(script) {
        sources.push(script.getAttribute("src") ?? "");
      },
    })
    .on("link[rel=stylesheet]", {
      element(link) {
        sources.push(link.getAttribute("href") ?? "");
      },
    });
  await rewriter.transform(new Response(html)).text();
  return sources;
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
