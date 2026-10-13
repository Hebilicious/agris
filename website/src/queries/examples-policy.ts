/**
 * Build-time only: runs every example through the public gateway's request protocol from `@agris/core`, with the
 * public document limits and the committed client schema. A query the gateway would refuse throws, so it fails the
 * site build instead of reaching a reader; every window the page shows is the policy the gateway chose.
 */
import { buildSchema } from "graphql";

import clientSchemaSdl from "../../../tools/schema/artifacts/client-schema.graphql?raw";
import {
  createPublicGatewayRequestProtocol,
  DEMO,
  SELF_HOSTED,
  type CacheFreshnessPolicy,
  type GatewayCachePolicy,
} from "../facts.ts";
import { isLocale, QUERY_KINDS, type CachePolicy, type FigureQuery, type QueryKind } from "../figure/model.ts";
import { EXAMPLES, type Example } from "./examples.ts";

export interface CheckedExample extends Example {
  /** The policy a self-hosted gateway chooses with the default cache freshness. */
  readonly policy: CachePolicy;
  /** The same query on the shared demo, with its own cache freshness. */
  readonly demoPolicy: CachePolicy;
  /** The full SHA-256 cache identity the gateway gives the query. */
  readonly identity: string;
}

const schema = buildSchema(clientSchemaSdl);

const protocolFor = (cacheFreshness: CacheFreshnessPolicy) =>
  createPublicGatewayRequestProtocol({ schema, cacheFreshness });

const PUBLIC = protocolFor(SELF_HOSTED.cacheFreshness);
const DEMO_PROTOCOL = protocolFor(DEMO.cacheFreshness);

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
  const demo = await normalized(DEMO_PROTOCOL, example);
  // The prose beside a query must not promise a cache behaviour the gateway does not give it.
  const claimsNeverStored = /never stored|not cached|always runs/i.test(example.text);
  if (claimsNeverStored && live.cachePolicy.mode !== "no-store") {
    throw new Error(`Example "${example.id}" says it is never stored, but the gateway stores its answer`);
  }
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
export const FIGURE_QUERIES: readonly FigureQuery[] = QUERY_KINDS.map((kind) => {
  const example = CHECKED_EXAMPLES.find((candidate) => candidate.card === kind);
  if (example === undefined) throw new Error(`No example sends the figure's "${kind}" card`);
  const locale = example.locale;
  if (!isLocale(locale)) throw new Error(`Example "${example.id}" names an unknown locale ${locale}`);
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
});
