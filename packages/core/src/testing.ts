import { composeSubgraphs } from "@graphql-mesh/compose-cli";
import { createGatewayRuntime, useCustomFetch } from "@graphql-hive/gateway-runtime";

import { createCatalogSubgraph } from "@agris/catalog-subgraph";
import {
  createMarketSubgraph,
  subgraphSchemaFromSdl,
  type MarketSummary,
  type MarketReader,
} from "@agris/market-subgraph";

export interface CentralMarketGraphTestRuntimeInput {
  readonly observedAt: string;
  readonly marketSummaries: readonly MarketSummary[];
}

export interface CentralMarketGraphObservedWork {
  readonly marketSummaryBatches: readonly (readonly number[])[];
  readonly catalogSubgraphRequests: number;
}

export interface CentralMarketGraphTestRuntime {
  readonly fetch: (request: Request) => Promise<Response>;
  observedWork(): CentralMarketGraphObservedWork;
}

const MARKET_SUBGRAPH_URL = "https://market-subgraph.internal/graphql";
const CATALOG_SUBGRAPH_URL = "https://catalog-subgraph.internal/graphql";
export function createCentralMarketGraphTestRuntime(
  input: CentralMarketGraphTestRuntimeInput,
): CentralMarketGraphTestRuntime {
  const marketSummaryBatches: number[][] = [];
  let catalogSubgraphRequests = 0;

  const unavailable = (concept: string): Promise<never> =>
    Promise.reject(new Error(`Market fixture does not provide ${concept}`));
  const marketReader: MarketReader = {
    readSummaries: async ({ itemIds }) => {
      marketSummaryBatches.push([...itemIds]);
      const selectedIds = new Set(itemIds);
      return input.marketSummaries.filter((summary) => selectedIds.has(summary.itemId));
    },
    readListings: () => unavailable("listings"),
    readOrderBook: () => unavailable("order books"),
    readPriceHistory: () => unavailable("price history"),
    readCatalog: () => unavailable("catalog items"),
    readHotItems: () => unavailable("hot items"),
    readRegistrations: () => unavailable("registrations"),
  };
  const marketSubgraph = createMarketSubgraph({
    reader: marketReader,
    clock: { nowIso: () => input.observedAt },
  });
  const catalogSubgraph = createCatalogSubgraph({ searchTelemetry: { record: () => undefined } });

  const composition = composeSubgraphs([
    {
      name: "market",
      schema: subgraphSchemaFromSdl(marketSubgraph.sdl),
      url: MARKET_SUBGRAPH_URL,
    },
    {
      name: "catalog",
      schema: subgraphSchemaFromSdl(catalogSubgraph.sdl),
      url: CATALOG_SUBGRAPH_URL,
    },
  ]);
  if (composition.errors !== undefined) {
    throw new Error(`Central Market test supergraph composition failed: ${composition.errors.join("; ")}`);
  }

  const gateway = createGatewayRuntime({
    supergraph: composition.supergraphSdl,
    graphiql: false,
    landingPage: false,
    logging: false,
    maskedErrors: false,
    plugins: () => [
      useCustomFetch(async (request, init) => {
        const url = request;
        const subgraphRequest = new Request(url, init);
        if (url === MARKET_SUBGRAPH_URL) return marketSubgraph.fetch(subgraphRequest);
        if (url === CATALOG_SUBGRAPH_URL) {
          catalogSubgraphRequests += 1;
          return catalogSubgraph.fetch(subgraphRequest);
        }
        throw new TypeError(`Unexpected Central Market test subgraph URL: ${url}`);
      }),
    ],
  });

  return {
    fetch: (request) => Promise.resolve(gateway.fetch(request)),
    observedWork: () => ({
      marketSummaryBatches: marketSummaryBatches.map((batch) => [...batch]),
      catalogSubgraphRequests,
    }),
  };
}
