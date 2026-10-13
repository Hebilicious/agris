import { PUBLIC_DOCUMENT_LIMITS } from "../facts.ts";

import type { QueryKind } from "../figure/model.ts";

/**
 * The example queries on the page. The build runs each one through the gateway's own public request protocol
 * (`examples-policy.ts`), so a query that the schema or the public limits would refuse fails the build, and every
 * cache window the page prints is the one the gateway would choose.
 */
export interface Example {
  readonly id: string;
  readonly title: string;
  /** What the answer shows, in one or two sentences. */
  readonly text: string;
  readonly query: string;
  /** The figure card that sends this query, if any. */
  readonly card?: QueryKind;
  /** Calls to Pearl Abyss one miss makes (see `FigureQuery.upstreamCalls`). */
  readonly upstreamCalls: number;
  readonly catalog: boolean;
  readonly market: boolean;
  /** The locale whose catalog drawer a names lookup opens. */
  readonly locale: string;
}

export const EXAMPLES: readonly Example[] = [
  {
    id: "prices",
    title: "Prices with names",
    text: "Three items on the EU market in one request: price, stock and trades from Pearl Abyss, names and grades joined in from the catalog.",
    card: "prices",
    upstreamCalls: 1,
    catalog: true,
    market: true,
    locale: "EN",
    query: `query Prices {
  market(region: EU) {
    observedAt
    items(ids: ["44195", "16001", "721003"]) {
      item { id name grade }
      basePrice
      currentStock
      totalTrades
    }
  }
}`,
  },
  {
    id: "search",
    title: "Search by name, with live summaries",
    text: "Part of a name, any case, accents ignored. Each hit carries its NA market summary. Search results are never stored, so this always runs.",
    card: "search",
    upstreamCalls: 1,
    catalog: true,
    market: true,
    locale: "EN",
    query: `query Search {
  searchItems(query: "memory frag", locale: EN, first: 3) {
    totalCount
    items {
      id
      name
      marketSummary(region: NA) { basePrice currentStock }
    }
  }
}`,
  },
  {
    id: "order-book",
    title: "Order book and price history",
    text: "Buy and sell orders at each price, and the recorded daily prices. Price history alone keeps much longer than the order book, and an answer keeps only as long as its shortest window.",
    card: "orderBook",
    upstreamCalls: 3,
    catalog: true,
    market: true,
    locale: "EN",
    query: `query OrderBook {
  market(region: EU) {
    items(ids: ["16001"]) {
      item { name }
      orderBook { price sellOrders buyOrders }
      priceHistory { offsetFromLatest price }
    }
  }
}`,
  },
  {
    id: "hot",
    title: "What is moving right now",
    text: "The market's hot list: which way each price moved and by how much.",
    card: "hot",
    upstreamCalls: 1,
    catalog: true,
    market: true,
    locale: "EN",
    query: `query HotItems {
  market(region: NA) {
    observedAt
    hotItems {
      direction
      amount
      marketItem { item { id name } basePrice currentStock }
    }
  }
}`,
  },
  {
    id: "registrations",
    title: "The registration queue",
    text: "Items waiting to be listed: enhancement level, price and when they go on sale.",
    upstreamCalls: 1,
    catalog: true,
    market: true,
    locale: "EN",
    query: `query Registrations {
  market(region: EU) {
    registrations {
      item { id name }
      enhancementLevel
      price
      registeredAt
    }
  }
}`,
  },
  {
    id: "names",
    title: "Names in Korean and French",
    text: "Catalog lookups never leave the catalog Worker: no Pearl Abyss call, and the answer keeps longer than any other.",
    card: "names",
    upstreamCalls: 0,
    catalog: true,
    market: false,
    locale: "KO",
    query: `query LocalizedNames {
  ko: items(ids: ["44195", "16001", "721003"], locale: KO) { id name grade }
  fr: items(ids: ["44195", "16001", "721003"], locale: FR) { id name }
}`,
  },
  {
    id: "regions",
    title: "One item across four regions",
    text: `Aliases put four markets side by side in one response. Each region is its own summary call; this query uses 4 of the ${PUBLIC_DOCUMENT_LIMITS.maxAliases} aliases a public query may use.`,
    upstreamCalls: 4,
    catalog: true,
    market: true,
    locale: "EN",
    query: `query CompareRegions {
  eu: market(region: EU) { items(ids: ["44195"]) { item { name } basePrice currentStock } }
  na: market(region: NA) { items(ids: ["44195"]) { basePrice currentStock } }
  kr: market(region: KR) { items(ids: ["44195"]) { basePrice currentStock } }
  asia: market(region: ASIA) { items(ids: ["44195"]) { basePrice currentStock } }
}`,
  },
];
