import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { gatewayProps } from "../../infra/src/gateway/props.ts";
import { DEMO_SETTINGS } from "../../infra/src/settings.ts";
import { buildSchema } from "graphql";

import { plainVariables } from "../support/deploy-bindings.ts";

import {
  CACHE_SETTING,
  cacheFreshnessFromBindings,
  classifyGatewayResponse,
  COORDINATE_CACHE_SETTINGS,
  createPublicGatewayRequestProtocol,
  DEFAULT_CACHE_FRESHNESS,
  type CacheFreshnessPolicy,
  type GatewayCachePolicy,
} from "../../packages/core/src/protocol/index.ts";
import {
  dataTableStepArgument,
  noStepArguments,
  step,
  type ExecutableFeatureManifest,
  type StepDefinition,
} from "../support/manifest.ts";

interface CacheFreshnessConfigurationWorld {
  policy?: CacheFreshnessPolicy;
  refusals?: readonly { readonly caseName: string; readonly variable: string; readonly outcome: unknown }[];
}

const clientSchema = buildSchema(
  await readFile(new URL("../../tools/schema/artifacts/client-schema.graphql", import.meta.url), "utf8"),
);

const QUERIES = {
  price: 'query Price { market(region: EU) { items(ids: ["1"]) { basePrice } } }',
  catalog: 'query Catalog { item(id: "1") { id } }',
  orderBook: 'query OrderBook { market(region: EU) { items(ids: ["1"]) { orderBook { price } } } }',
  summary: 'query Summary { item(id: "1") { marketSummary(region: EU) { basePrice } } }',
  search: 'query Search { searchItems(query: "black stone", locale: EN) { totalCount items { id name } } }',
  searchSummary:
    'query SearchPrices { searchItems(query: "black stone", locale: EN) { items { id marketSummary(region: EU) { basePrice } } } }',
} as const;

const window = (maxAgeSeconds: number, staleWhileRevalidateSeconds: number) => ({
  maxAgeSeconds,
  staleWhileRevalidateSeconds,
});

/** Each refused case, and the variable its error must name. */
const REFUSED_BINDINGS: Readonly<Record<string, { readonly variable: string; readonly bindings: object }>> = {
  "a CACHE_ variable that is not a setting": {
    variable: "CACHE_MINIMUM_SECOND",
    bindings: { CACHE_MINIMUM_SECOND: "600" },
  },
  "a negative window": {
    variable: "CACHE_MARKET_ITEMS_MAX_AGE_SECONDS",
    bindings: { CACHE_MARKET_ITEMS_MAX_AGE_SECONDS: "-1" },
  },
  "a fractional window": {
    variable: "CACHE_MARKET_ITEMS_STALE_WHILE_REVALIDATE_SECONDS",
    bindings: { CACHE_MARKET_ITEMS_STALE_WHILE_REVALIDATE_SECONDS: "1.5" },
  },
  "text that is not a number": {
    variable: "CACHE_STALE_IF_ERROR_SECONDS",
    bindings: { CACHE_STALE_IF_ERROR_SECONDS: "a day" },
  },
  "a negative floor": { variable: "CACHE_MINIMUM_SECONDS", bindings: { CACHE_MINIMUM_SECONDS: -600 } },
  "a never-stored coordinate not in schema": {
    variable: "CACHE_NEVER_STORED",
    bindings: { CACHE_NEVER_STORED: "Query.search" },
  },
  "a never-stored name that is not a field": {
    variable: "CACHE_NEVER_STORED",
    bindings: { CACHE_NEVER_STORED: "Item.marketSummary,orderBook" },
  },
  "a switch that is not true or false": { variable: "CACHE_ENABLED", bindings: { CACHE_ENABLED: "off" } },
};

async function cachePolicy(policy: CacheFreshnessPolicy | undefined, query: keyof typeof QUERIES) {
  assert.ok(policy);
  const protocol = createPublicGatewayRequestProtocol({ schema: clientSchema, cacheFreshness: policy });
  const result = await protocol.normalize({
    method: "POST",
    contentType: "application/json",
    searchParams: "",
    bodyText: JSON.stringify({ query: QUERIES[query] }),
  });
  assert.ok(result.ok, result.ok ? undefined : result.error.message);
  return result.value.cachePolicy;
}

/** A storable result under `policy`, which supplies its `stale-if-error` window. */
function stored(
  policy: CacheFreshnessPolicy,
  maxAgeSeconds: number,
  staleWhileRevalidateSeconds: number,
): GatewayCachePolicy {
  return { mode: "store", maxAgeSeconds, staleWhileRevalidateSeconds, staleIfErrorSeconds: policy.staleIfErrorSeconds };
}

function refusal(bindings: object): unknown {
  try {
    cacheFreshnessFromBindings(bindings, clientSchema);
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

/** The plain-text variables the demo stage's gateway binds, as the deploy definition declares them. */
async function demoGatewayVariables(): Promise<object> {
  return plainVariables(gatewayProps(DEMO_SETTINGS).env);
}

const steps: readonly StepDefinition<CacheFreshnessConfigurationWorld>[] = [
  step(
    "the gateway bindings set no CACHE_ variable beside the subgraphs and the smoke mode",
    noStepArguments,
    (world) => {
      world.policy = cacheFreshnessFromBindings({ MARKET: {}, CATALOG: {}, CACHE_SMOKE_MODE: "enabled" }, clientSchema);
    },
  ),
  step("the policy is the default policy itself", noStepArguments, (world) => {
    assert.equal(world.policy, DEFAULT_CACHE_FRESHNESS);
  }),
  step("the default policy has these windows", dataTableStepArgument, (world, table) => {
    const expected = Object.fromEntries(
      table.hashes.map((row) => [row.coordinate, window(Number(row.fresh), Number(row["stale while revalidating"]))]),
    );
    assert.deepEqual(world.policy?.coordinates, expected);
  }),
  step("the default policy keeps stored answers for 86400 seconds after a failed refresh", noStepArguments, (world) => {
    assert.equal(world.policy?.staleIfErrorSeconds, 86_400);
  }),
  step("the default policy stores every coordinate and sets no floor", noStepArguments, (world) => {
    assert.equal(world.policy?.enabled, true);
    assert.deepEqual(world.policy?.neverStored, []);
    assert.equal(world.policy?.minimumSeconds, 0);
  }),
  step("a market summary query is stored for 60 seconds and revalidates for 70", noStepArguments, async (world) => {
    assert.ok(world.policy);
    assert.deepEqual(await cachePolicy(world.policy, "summary"), stored(world.policy, 60, 70));
  }),
  step("a search query is stored for 31536000 seconds and revalidates for 86400", noStepArguments, async (world) => {
    assert.ok(world.policy);
    assert.deepEqual(await cachePolicy(world.policy, "search"), stored(world.policy, 31_536_000, 86_400));
  }),
  step(
    "a search query that selects market summaries is stored for 60 seconds and revalidates for 70",
    noStepArguments,
    async (world) => {
      assert.ok(world.policy);
      assert.deepEqual(await cachePolicy(world.policy, "searchSummary"), stored(world.policy, 60, 70));
    },
  ),
  step("the gateway bindings name Item.marketSummary in CACHE_NEVER_STORED", noStepArguments, (world) => {
    world.policy = cacheFreshnessFromBindings({ CACHE_NEVER_STORED: "Item.marketSummary" }, clientSchema);
  }),
  step(
    "a market summary query is never stored while a search query is still stored",
    noStepArguments,
    async (world) => {
      assert.ok(world.policy);
      assert.deepEqual(await cachePolicy(world.policy, "summary"), { mode: "no-store" });
      assert.deepEqual(await cachePolicy(world.policy, "search"), stored(world.policy, 31_536_000, 86_400));
    },
  ),
  step("the cache settings are listed", noStepArguments, () => undefined),
  step("each coordinate's window is set by these variables", dataTableStepArgument, (_world, table) => {
    assert.deepEqual(
      COORDINATE_CACHE_SETTINGS.map(({ coordinate, maxAgeSeconds, staleWhileRevalidateSeconds }) => ({
        coordinate,
        fresh: maxAgeSeconds,
        "stale while revalidating": staleWhileRevalidateSeconds,
      })),
      table.hashes,
    );
  }),
  step(
    "the other settings are CACHE_ENABLED, CACHE_STALE_IF_ERROR_SECONDS, CACHE_MINIMUM_SECONDS and CACHE_NEVER_STORED",
    noStepArguments,
    () => {
      assert.deepEqual(Object.values(CACHE_SETTING), [
        "CACHE_ENABLED",
        "CACHE_STALE_IF_ERROR_SECONDS",
        "CACHE_MINIMUM_SECONDS",
        "CACHE_NEVER_STORED",
      ]);
    },
  ),
  step(
    "the gateway bindings give Market.items 120 seconds fresh and 130 stale, and stale-if-error 600",
    noStepArguments,
    (world) => {
      world.policy = cacheFreshnessFromBindings(
        {
          CACHE_MARKET_ITEMS_MAX_AGE_SECONDS: "120",
          CACHE_MARKET_ITEMS_STALE_WHILE_REVALIDATE_SECONDS: "130",
          CACHE_STALE_IF_ERROR_SECONDS: "600",
        },
        clientSchema,
      );
    },
  ),
  step("a price query is stored for 120 seconds and revalidates for 130", noStepArguments, async (world) => {
    assert.ok(world.policy);
    assert.deepEqual(await cachePolicy(world.policy, "price"), stored(world.policy, 120, 130));
  }),
  step("a catalog query keeps its default window", noStepArguments, async (world) => {
    assert.ok(world.policy);
    assert.deepEqual(await cachePolicy(world.policy, "catalog"), stored(world.policy, 31_536_000, 86_400));
  }),
  step(
    "a stored price answer carries stale-if-error 600 in its Cache-Control header",
    noStepArguments,
    async (world) => {
      const classification = classifyGatewayResponse({
        cacheStatus: "MISS",
        cachePolicy: await cachePolicy(world.policy, "price"),
        hasGraphqlErrors: false,
        upstream: "answered",
      });
      assert.equal(
        classification.headers["Cache-Control"],
        "public, max-age=120, stale-while-revalidate=130, stale-if-error=600",
      );
    },
  ),
  step("the gateway bindings set CACHE_ENABLED to false", noStepArguments, (world) => {
    world.policy = cacheFreshnessFromBindings({ CACHE_ENABLED: "false" }, clientSchema);
  }),
  step("a price query, a catalog query and an order book query are never stored", noStepArguments, async (world) => {
    for (const query of ["price", "catalog", "orderBook"] as const) {
      assert.deepEqual(await cachePolicy(world.policy, query), { mode: "no-store" }, query);
    }
  }),
  step("the gateway bindings set Market.items to 0 seconds fresh with a 600 second floor", noStepArguments, (world) => {
    world.policy = cacheFreshnessFromBindings(
      { CACHE_MARKET_ITEMS_MAX_AGE_SECONDS: "0", CACHE_MINIMUM_SECONDS: "600" },
      clientSchema,
    );
  }),
  step("a price query is never stored", noStepArguments, async (world) => {
    assert.deepEqual(await cachePolicy(world.policy, "price"), { mode: "no-store" });
  }),
  step("a catalog query is stored for at least 600 seconds", noStepArguments, async (world) => {
    const policy = await cachePolicy(world.policy, "catalog");
    assert.equal(policy.mode, "store");
    assert.ok(policy.maxAgeSeconds >= 600 && policy.staleWhileRevalidateSeconds >= 600);
  }),
  step(
    "the gateway bindings set every window, stale-if-error and the floor to 0 and store every coordinate",
    noStepArguments,
    (world) => {
      const zeroes = Object.fromEntries(
        COORDINATE_CACHE_SETTINGS.flatMap((setting) => [
          [setting.maxAgeSeconds, "0"],
          [setting.staleWhileRevalidateSeconds, "0"],
        ]),
      );
      world.policy = cacheFreshnessFromBindings(
        { ...zeroes, CACHE_STALE_IF_ERROR_SECONDS: "0", CACHE_MINIMUM_SECONDS: "0", CACHE_NEVER_STORED: "" },
        clientSchema,
      );
    },
  ),
  step("a market summary query is never stored", noStepArguments, async (world) => {
    assert.deepEqual(world.policy?.neverStored, []);
    assert.deepEqual(await cachePolicy(world.policy, "summary"), { mode: "no-store" });
  }),
  step("the gateway bindings carry these values", dataTableStepArgument, (world, table) => {
    world.refusals = table.hashes.map((row) => {
      const caseName = row.case;
      assert.ok(caseName);
      const refused = REFUSED_BINDINGS[caseName];
      assert.ok(refused, `Unknown binding case: ${caseName}`);
      return { caseName, variable: refused.variable, outcome: refusal(refused.bindings) };
    });
  }),
  step("every value is refused with an error that names its variable", noStepArguments, (world) => {
    assert.ok(world.refusals && world.refusals.length > 0);
    for (const { caseName, variable, outcome } of world.refusals) {
      assert.ok(outcome instanceof TypeError, `${caseName} was accepted`);
      assert.ok(outcome.message.includes(variable), `${caseName}: ${outcome.message}`);
    }
  }),
  step("the demo configuration's gateway bindings are loaded", noStepArguments, async (world) => {
    world.policy = cacheFreshnessFromBindings(await demoGatewayVariables(), clientSchema);
  }),
  step("its policy is the default policy with a 600 second floor", noStepArguments, (world) => {
    assert.deepEqual(world.policy, { ...DEFAULT_CACHE_FRESHNESS, minimumSeconds: 600 });
  }),
];

export const cacheFreshnessConfigurationFeature: ExecutableFeatureManifest<CacheFreshnessConfigurationWorld> = {
  id: "cache-freshness-configuration",
  uri: "tests/features/cache-freshness-configuration.feature",
  createWorld: () => ({}),
  steps,
};
