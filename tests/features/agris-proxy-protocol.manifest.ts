import assert from "node:assert/strict";

import { buildSchema } from "graphql";

import {
  createGatewayRequestProtocol,
  type GatewayProtocolRequest,
  type GatewayProtocolResult,
  type GatewayRequestProtocol,
  type NormalizedGatewayRequest,
  validatePersistedOperations,
} from "../../packages/core/src/protocol/index.ts";
import {
  dataTableStepArgument,
  noStepArguments,
  step,
  stringStepArgument,
  type ExecutableFeatureManifest,
  type StepDefinition,
} from "../support/manifest.ts";

const SUMMARY_OPERATION_ID = "378ea7484c35df8ac3a7f0de86f93115e87149b1104071df6a531d022eee9d5b";
const summaryDocument = `
  query MarketSummary($filter: MarketFilter!, $region: MarketRegion!) {
    market(region: $region, filter: $filter) {
      items {
        basePrice
      }
    }
  }
`;

const schema = buildSchema(`
  enum MarketRegion { EU NA }
  input MarketCategoryInput { main: Int!, sub: Int }
  input MarketFilter { ids: [ID!]!, category: MarketCategoryInput }
  type MarketItem { basePrice: Float }
  type Market { items: [MarketItem!]! }
  type Query { market(region: MarketRegion!, filter: MarketFilter!): Market! }
`);

interface GatewayProtocolWorld {
  protocol?: GatewayRequestProtocol;
  post?: NormalizedGatewayRequest;
  reordered?: NormalizedGatewayRequest;
  rejections?: readonly {
    readonly caseName: string;
    readonly expectedCode: string;
    readonly result: GatewayProtocolResult;
  }[];
  manifestFailure?: unknown;
}

const steps: readonly StepDefinition<GatewayProtocolWorld>[] = [
  step("a Central Market summary query", noStepArguments, (world) => {
    world.protocol = createGatewayRequestProtocol({ schema });
  }),
  step("nested variables canonicalize to {string}", stringStepArgument, (world, canonicalVariables) => {
    assert.equal(world.post?.canonicalVariables, canonicalVariables);
    assert.equal(world.reordered?.canonicalVariables, canonicalVariables);
  }),
  step("the Agris Proxy normalizes these disallowed requests", dataTableStepArgument, async (world, table) => {
    assert.ok(world.protocol);
    const protocol = world.protocol;
    world.rejections = await Promise.all(
      table.hashes.map(async (row) => {
        const caseName = row.case;
        const expectedCode = row.error;
        assert.ok(caseName);
        assert.ok(expectedCode);
        return {
          caseName,
          expectedCode,
          result: await protocol.normalize(disallowedRequest(caseName)),
        };
      }),
    );
  }),
  step("every disallowed request is rejected with its specified protocol error", noStepArguments, (world) => {
    assert.ok(world.rejections);
    for (const rejection of world.rejections) {
      assert.equal(rejection.result.ok, false, `${rejection.caseName} was unexpectedly accepted`);
      if (rejection.result.ok) continue;
      assert.equal(rejection.result.error.code, rejection.expectedCode, rejection.caseName);
    }
  }),
  step(
    "an approved-operation list assigns the summary query to another lowercase hash",
    noStepArguments,
    async (world) => {
      try {
        await validatePersistedOperations(schema, { ["f".repeat(64)]: { document: summaryDocument } });
      } catch (error) {
        world.manifestFailure = error;
      }
    },
  ),
  step("list validation rejects the hash and document mismatch", noStepArguments, (world) => {
    assert.ok(world.manifestFailure instanceof TypeError);
    assert.match(world.manifestFailure.message, /hash does not match its canonical document/u);
  }),
];

export const agrisProxyProtocolFeature: ExecutableFeatureManifest<GatewayProtocolWorld> = {
  id: "central-market-agris-proxy-protocol",
  uri: "tests/features/agris-proxy-protocol.feature",
  createWorld: () => ({}),
  steps,
};

function disallowedRequest(caseName: string): GatewayProtocolRequest {
  const validVariables = JSON.stringify({
    filter: { ids: ["44195"], category: { main: 20 } },
    region: "EU",
  });
  const post = (bodyText: string, contentType = "application/json"): GatewayProtocolRequest => ({
    method: "POST",
    contentType,
    searchParams: "",
    bodyText,
  });

  switch (caseName) {
    case "request array":
      return post(JSON.stringify([{ query: summaryDocument, variables: JSON.parse(validVariables) }]));
    case "malformed JSON body":
      return post("{");
    case "missing content type":
      return {
        ...post(JSON.stringify({ query: summaryDocument, variables: JSON.parse(validVariables) })),
        contentType: null,
      };
    case "malformed content type":
      return post(
        JSON.stringify({ query: summaryDocument, variables: JSON.parse(validVariables) }),
        "application/json; charset",
      );
    case "multipart body":
      return post("--graphql", "multipart/form-data; boundary=graphql");
    case "variables array":
      return post(JSON.stringify({ query: summaryDocument, variables: [] }));
    case "prototype-shaped variable":
      return post(
        `{"query":${JSON.stringify(summaryDocument)},"variables":{"filter":{"ids":["44195"],"category":{"main":20},"__proto__":{"polluted":true}},"region":"EU"}}`,
      );
    case "missing required variable":
      return post(JSON.stringify({ query: summaryDocument, variables: { region: "EU" } }));
    case "malformed query document":
      return post(JSON.stringify({ query: "query Broken {", variables: {} }));
    case "multiple operations":
      return post(JSON.stringify({ query: "query One { __typename } query Two { __typename }", variables: {} }));
    case "mutation":
      return post(JSON.stringify({ query: "mutation Change { __typename }", variables: {} }));
    case "subscription":
      return post(JSON.stringify({ query: "subscription Changes { __typename }", variables: {} }));
    case "GET request":
      return {
        method: "GET",
        contentType: null,
        searchParams: new URLSearchParams({ id: SUMMARY_OPERATION_ID, variables: validVariables }).toString(),
        bodyText: null,
      };
    case "unsupported method":
      return { method: "PUT", contentType: "application/json", searchParams: "", bodyText: "{}" };
    default:
      throw new Error(`Unknown disallowed protocol fixture: ${caseName}`);
  }
}
