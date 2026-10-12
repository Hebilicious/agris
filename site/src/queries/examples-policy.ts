/**
 * Build-time only: runs every example through the public gateway's request protocol from `@agris/core`, with the
 * public document limits and the committed client schema. A query the gateway would refuse throws, so it fails the
 * site build instead of reaching a reader; every window the page shows is the policy the gateway chose.
 */
import {
  CACHE_POLICY_VERSION,
  createGatewayRequestProtocol,
  PUBLIC_DOCUMENT_LIMITS,
  type GatewayCachePolicy,
} from "@agris/core";
import { buildSchema } from "graphql";

import clientSchemaSdl from "../../../tools/graph/artifacts/client-schema.graphql?raw";
import { LOCALES, type CachePolicy, type FigureQuery, type QueryKind } from "../figure/model";
import { EXAMPLES, type Example } from "./examples";

/** The hosted demo's freshness floor: `MARKET_CACHE_MIN_TTL_SECONDS` in `workers/gateway/cloudflare.config.ts`. */
export const DEMO_FRESHNESS_FLOOR_SECONDS = 600;

export interface CheckedExample extends Example {
  readonly policy: CachePolicy;
  /** The same query on the shared demo, after its freshness floor. */
  readonly demoPolicy: CachePolicy;
  /** The full SHA-256 cache identity the gateway gives the query. */
  readonly identity: string;
}

const schema = buildSchema(clientSchemaSdl);

const protocolFor = (freshnessFloorSeconds: number) =>
  createGatewayRequestProtocol({
    schema,
    documentLimits: PUBLIC_DOCUMENT_LIMITS,
    acceptExtensions: true,
    freshnessFloorSeconds,
  });

const PUBLIC = protocolFor(0);
const DEMO = protocolFor(DEMO_FRESHNESS_FLOOR_SECONDS);

async function normalized(protocol: ReturnType<typeof protocolFor>, example: Example) {
  const result = await protocol.normalize({
    method: "POST",
    contentType: "application/json",
    searchParams: "",
    bodyText: JSON.stringify({ query: example.query }),
  });
  if (!result.ok) throw new Error(`Example "${example.id}" is refused by the public gateway: ${result.error.message}`);
  return result.value;
}

function policyOf(policy: GatewayCachePolicy): CachePolicy {
  if (policy.mode === "no-store") return { mode: "no-store" };
  return {
    mode: "store",
    maxAge: policy.maxAgeSeconds,
    staleWhileRevalidate: policy.staleWhileRevalidateSeconds,
    staleIfError: policy.staleIfErrorSeconds,
  };
}

async function check(example: Example): Promise<CheckedExample> {
  const live = await normalized(PUBLIC, example);
  const demo = await normalized(DEMO, example);
  return {
    ...example,
    policy: policyOf(live.cachePolicy),
    demoPolicy: policyOf(demo.cachePolicy),
    identity: live.operationIdentity,
  };
}

/** Every example, checked, in page order. */
export const CHECKED_EXAMPLES: readonly CheckedExample[] = await Promise.all(EXAMPLES.map(check));

const LABELS: Record<QueryKind, string> = {
  prices: "Prices",
  orderBook: "Order book",
  hot: "Hot items",
  names: "Item names",
  search: "Search",
};

/** The figure's cards, one per example that names a card, in the order of `QueryKind`. */
export const FIGURE_QUERIES: readonly FigureQuery[] = (["prices", "orderBook", "hot", "names", "search"] as const).map(
  (kind) => {
    const example = CHECKED_EXAMPLES.find((candidate) => candidate.card === kind);
    if (example === undefined) throw new Error(`No example sends the figure's "${kind}" card`);
    const locale = LOCALES.findIndex((candidate) => candidate === example.locale);
    if (locale < 0) throw new Error(`Example "${example.id}" names an unknown locale ${example.locale}`);
    return {
      kind,
      label: LABELS[kind],
      policy: example.policy,
      key: example.identity.slice(0, 8),
      upstreamCalls: example.upstreamCalls,
      catalog: example.catalog,
      market: example.market,
      locale,
    };
  },
);

export { CACHE_POLICY_VERSION };
