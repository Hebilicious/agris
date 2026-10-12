import assert from "node:assert/strict";

import { buildSchema, getIntrospectionQuery } from "graphql";

import {
  createGatewayRequestProtocol,
  PUBLIC_DOCUMENT_LIMITS,
  publicGetBody,
  type GatewayCachePolicy,
  type GatewayProtocolResult,
  type GatewayRequestProtocol,
  type PublicGetBodyResult,
} from "../../packages/core/src/protocol/index.ts";
import {
  dataTableStepArgument,
  noStepArguments,
  step,
  type ExecutableFeatureManifest,
  type StepDefinition,
} from "../support/manifest.ts";

const limitsSchema = buildSchema(`
  type Node { id: ID!, child: Node }
  type Query { node: Node }
`);

// The coordinates the freshness policy names: `Market.items` is a 60 second price, `Query.item` a year-long catalog
// entry, and `Item.marketSummary` is never stored.
const freshnessSchema = buildSchema(`
  type Summary { basePrice: Int }
  type Item { id: ID!, marketSummary: Summary }
  type MarketItem { basePrice: Int }
  type Market { items(ids: [ID!]!): [MarketItem!] }
  type Query { market: Market!, item(id: ID!): Item }
`);

const LIMIT_CASES: Readonly<Record<string, string>> = {
  "within every limit": "query Within { node { id child { id } } }",
  "nested four fields deep": "query Deep { node { child { child { id } } } }",
  "deep through a fragment":
    "query DeepFragment { node { ...Nested } } fragment Nested on Node { child { child { id } } }",
  "seven fields": "query Wide { node { id id id id id id } }",
  "seven fields through spreads":
    "query WideSpreads { node { ...Pair ...Pair ...Pair } } fragment Pair on Node { id id }",
  "three aliases": "query Aliased { node { first: id second: id third: id } }",
  mutation: "mutation Change { node { id } }",
};

const FRESHNESS_QUERIES = {
  price: 'query Price { market { items(ids: ["1"]) { basePrice } } }',
  catalog: 'query Catalog { item(id: "1") { id } }',
  summary: 'query Summary { item(id: "1") { marketSummary { basePrice } } }',
} as const;

type FreshnessQuery = keyof typeof FRESHNESS_QUERIES;

const EXTENSIONS_QUERY = "query WithExtensions { node { id } }";

const RECURSIVE_INTROSPECTION = "__schema { types { fields { type { fields { name } } } } }";

const INTROSPECTION_CASES: Readonly<Record<string, string>> = {
  // What GraphiQL sends, with every option it enables.
  "GraphiQL's introspection query": getIntrospectionQuery({
    descriptions: true,
    specifiedByUrl: true,
    directiveIsRepeatable: true,
    schemaDescription: true,
    inputValueDeprecation: true,
  }),
  "fields of the types of fields": `query Recursive { ${RECURSIVE_INTROSPECTION} }`,
  "the same recursion beside a regular field": `query Mixed { node { id } ${RECURSIVE_INTROSPECTION} }`,
  "an introspection field beside a deep query":
    "query MixedDeep { __typename node { child { child { child { child { child { child { child { child { id } } } } } } } } } }",
};

const PERSISTED_ID = "2e23b7343c2a4c210e1d83395e8c3fe2a393af63840cac8f4e58b3e79d9f87a6";
const PERSISTED_QUERY = "query Persisted { market { observedAt } }";
const GET_VARIABLES = encodeURIComponent('{"region":"EU"}');

const GET_CASES: Readonly<Record<string, string>> = {
  "inline query": `query=${encodeURIComponent(PERSISTED_QUERY)}&variables=${GET_VARIABLES}`,
  "persisted id": `id=${PERSISTED_ID}&variables=${GET_VARIABLES}`,
  "unknown persisted id": `id=${"0".repeat(64)}`,
  "both query and id": `query=${encodeURIComponent(PERSISTED_QUERY)}&id=${PERSISTED_ID}`,
  "neither query nor id": `variables=${GET_VARIABLES}`,
  "repeated variables": `id=${PERSISTED_ID}&variables=${GET_VARIABLES}&variables=${GET_VARIABLES}`,
  "unexpected parameter": `id=${PERSISTED_ID}&extensions=%7B%7D`,
  "variables that are not JSON": `id=${PERSISTED_ID}&variables=%7Bregion`,
};

interface PublicQueryProtocolWorld {
  protocol?: GatewayRequestProtocol;
  outcomes?: readonly {
    readonly caseName: string;
    readonly expected: string;
    readonly result: GatewayProtocolResult;
  }[];
  withoutFloor?: Readonly<Record<FreshnessQuery, GatewayCachePolicy>>;
  withFloor?: Readonly<Record<FreshnessQuery, GatewayCachePolicy>>;
  persistedDocuments?: ReadonlyMap<string, string>;
  getOutcomes?: readonly {
    readonly caseName: string;
    readonly expected: string;
    readonly result: PublicGetBodyResult;
  }[];
  extensionOutcomes?: {
    readonly public: GatewayProtocolResult;
    readonly private: GatewayProtocolResult;
    readonly publicNotObject: GatewayProtocolResult;
  };
}

const steps: readonly StepDefinition<PublicQueryProtocolWorld>[] = [
  step("a deployment whose only persisted operation is the example market query", noStepArguments, (world) => {
    world.persistedDocuments = new Map([[PERSISTED_ID, PERSISTED_QUERY]]);
  }),
  step("these GET query strings are read", dataTableStepArgument, (world, table) => {
    const persistedDocuments = world.persistedDocuments;
    assert.ok(persistedDocuments);
    world.getOutcomes = table.hashes.map((row) => {
      const caseName = row.case;
      const expected = row.outcome;
      assert.ok(caseName);
      assert.ok(expected);
      const search = GET_CASES[caseName];
      assert.ok(search !== undefined, `Unknown GET case: ${caseName}`);
      return { caseName, expected, result: publicGetBody(search, persistedDocuments) };
    });
  }),
  step("every query string meets its specified outcome", noStepArguments, (world) => {
    assert.ok(world.getOutcomes);
    for (const { caseName, expected, result } of world.getOutcomes) {
      if (expected === "body") {
        assert.equal(result.ok, true, `${caseName}: ${result.ok ? "" : result.error.message}`);
        continue;
      }
      assert.equal(result.ok, false, `${caseName} was unexpectedly accepted`);
      if (result.ok) continue;
      assert.equal(result.error.code, expected, caseName);
      assert.equal(result.error.status, 400, caseName);
    }
  }),
  step("the persisted id reads as the inline query with the same variables", noStepArguments, (world) => {
    const bodies = new Map(
      (world.getOutcomes ?? []).flatMap(({ caseName, result }) => (result.ok ? [[caseName, result.bodyText]] : [])),
    );
    assert.ok(bodies.get("persisted id"));
    assert.equal(bodies.get("persisted id"), bodies.get("inline query"));
  }),
  step(
    "a request protocol with a depth limit of 3, a field limit of 6 and an alias limit of 2",
    noStepArguments,
    (world) => {
      world.protocol = createGatewayRequestProtocol({
        schema: limitsSchema,
        documentLimits: { maxDepth: 3, maxFields: 6, maxAliases: 2 },
      });
    },
  ),
  step("the protocol normalizes these queries", dataTableStepArgument, async (world, table) => {
    world.outcomes = await normalizeCases(world.protocol, table.hashes, LIMIT_CASES);
  }),
  step("the public request protocol", noStepArguments, (world) => {
    world.protocol = createGatewayRequestProtocol({
      schema: limitsSchema,
      documentLimits: PUBLIC_DOCUMENT_LIMITS,
      acceptExtensions: true,
    });
  }),
  step("the protocol normalizes these introspection queries", dataTableStepArgument, async (world, table) => {
    world.outcomes = await normalizeCases(world.protocol, table.hashes, INTROSPECTION_CASES);
  }),
  step(
    "a query with an empty extensions object is sent to the public and to the private protocol",
    noStepArguments,
    async (world) => {
      const publicProtocol = createGatewayRequestProtocol({ schema: limitsSchema, acceptExtensions: true });
      const privateProtocol = createGatewayRequestProtocol({ schema: limitsSchema });
      world.extensionOutcomes = {
        public: await publicProtocol.normalize(postRequest(EXTENSIONS_QUERY, {})),
        private: await privateProtocol.normalize(postRequest(EXTENSIONS_QUERY, {})),
        publicNotObject: await publicProtocol.normalize(postRequest(EXTENSIONS_QUERY, "headers")),
      };
    },
  ),
  step("the public protocol accepts it and the private protocol refuses it", noStepArguments, (world) => {
    assert.equal(world.extensionOutcomes?.public.ok, true);
    const refused = world.extensionOutcomes?.private;
    assert.ok(refused && !refused.ok);
    assert.equal(refused.error.code, "invalid-request");
  }),
  step("the public protocol refuses extensions that are not an object", noStepArguments, (world) => {
    const refused = world.extensionOutcomes?.publicNotObject;
    assert.ok(refused && !refused.ok);
    assert.equal(refused.error.code, "invalid-request");
  }),
  step("every query meets its specified outcome", noStepArguments, (world) => {
    assert.ok(world.outcomes);
    for (const { caseName, expected, result } of world.outcomes) {
      if (expected === "accepted") {
        assert.equal(result.ok, true, `${caseName}: ${result.ok ? "" : result.error.message}`);
        continue;
      }
      assert.equal(result.ok, false, `${caseName} was unexpectedly accepted`);
      if (result.ok) continue;
      assert.equal(result.error.code, expected, caseName);
      assert.equal(result.error.status, 400, caseName);
    }
  }),
  step(
    "the same queries are normalized with and without a freshness floor of 600 seconds",
    noStepArguments,
    async (world) => {
      world.withoutFloor = await cachePolicies(createGatewayRequestProtocol({ schema: freshnessSchema }));
      world.withFloor = await cachePolicies(
        createGatewayRequestProtocol({ schema: freshnessSchema, freshnessFloorSeconds: 600 }),
      );
    },
  ),
  step(
    "without the floor a 60 second result stays fresh for 60 seconds and revalidates for 70",
    noStepArguments,
    (world) => {
      assert.deepEqual(world.withoutFloor?.price, storedPolicy(60, 70));
    },
  ),
  step("with the floor it stays fresh for 600 seconds and revalidates for 600", noStepArguments, (world) => {
    assert.deepEqual(world.withFloor?.price, storedPolicy(600, 600));
  }),
  step("with the floor a result the schema keeps for a year still keeps for a year", noStepArguments, (world) => {
    assert.deepEqual(world.withoutFloor?.catalog, storedPolicy(31_536_000, 86_400));
    assert.deepEqual(world.withFloor?.catalog, storedPolicy(31_536_000, 86_400));
  }),
  step("with the floor an uncacheable result stays uncacheable", noStepArguments, (world) => {
    assert.deepEqual(world.withoutFloor?.summary, { mode: "no-store" });
    assert.deepEqual(world.withFloor?.summary, { mode: "no-store" });
  }),
];

export const publicQueryProtocolFeature: ExecutableFeatureManifest<PublicQueryProtocolWorld> = {
  id: "public-query-protocol",
  uri: "tests/features/public-query-protocol.feature",
  createWorld: () => ({}),
  steps,
};

function postRequest(query: string, extensions?: unknown) {
  return {
    method: "POST",
    contentType: "application/json",
    searchParams: "",
    bodyText: JSON.stringify(extensions === undefined ? { query } : { query, extensions }),
  };
}

async function normalizeCases(
  protocol: GatewayRequestProtocol | undefined,
  rows: readonly Readonly<Record<string, string>>[],
  cases: Readonly<Record<string, string>>,
): Promise<NonNullable<PublicQueryProtocolWorld["outcomes"]>> {
  assert.ok(protocol);
  return Promise.all(
    rows.map(async (row) => {
      const caseName = row.case;
      const expected = row.outcome;
      assert.ok(caseName);
      assert.ok(expected);
      const query = cases[caseName];
      assert.ok(query, `Unknown query case: ${caseName}`);
      return { caseName, expected, result: await protocol.normalize(postRequest(query)) };
    }),
  );
}

async function cachePolicies(protocol: GatewayRequestProtocol): Promise<Record<FreshnessQuery, GatewayCachePolicy>> {
  const policy = async (query: FreshnessQuery): Promise<GatewayCachePolicy> => {
    const result = await protocol.normalize(postRequest(FRESHNESS_QUERIES[query]));
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    return result.value.cachePolicy;
  };
  return { price: await policy("price"), catalog: await policy("catalog"), summary: await policy("summary") };
}

function storedPolicy(maxAgeSeconds: number, staleWhileRevalidateSeconds: number): GatewayCachePolicy {
  return { mode: "store", maxAgeSeconds, staleWhileRevalidateSeconds, staleIfErrorSeconds: 86_400 };
}
