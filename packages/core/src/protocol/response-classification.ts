import type {
  GatewayResponseClassification,
  GatewayResponseClassificationInput,
  GatewayResponseRefresh,
  GatewayResponseSource,
  GatewayUpstreamOutcome,
} from "./types.js";

interface GatewayDeliveryClassification {
  readonly source: GatewayResponseSource;
  readonly refresh: GatewayResponseRefresh;
}

const UPSTREAM_STATUS = {
  answered: 200,
  "rate-limited": 429,
  unavailable: 503,
} as const satisfies Record<GatewayUpstreamOutcome, GatewayResponseClassification["status"]>;

/** A response is stored only when it has no errors and a subgraph answered; a 429 or a 503 is never stored. */
export function classifyGatewayResponse(input: GatewayResponseClassificationInput): GatewayResponseClassification {
  const failed = input.hasGraphqlErrors || input.upstream !== "answered";
  const delivery = classifyDelivery(input.cacheStatus, failed);
  return {
    status: UPSTREAM_STATUS[input.upstream],
    headers: {
      "Cache-Control": cacheControl(input, failed),
      "X-Central-Market-Source": delivery.source,
      "X-Central-Market-Refresh": delivery.refresh,
    },
  };
}

function cacheControl(input: GatewayResponseClassificationInput, failed: boolean): string {
  if (failed || input.cachePolicy.mode === "no-store") return "no-store";
  const { maxAgeSeconds, staleWhileRevalidateSeconds, staleIfErrorSeconds } = input.cachePolicy;
  return `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}, stale-if-error=${staleIfErrorSeconds}`;
}

function classifyDelivery(
  cacheStatus: GatewayResponseClassificationInput["cacheStatus"],
  failed: boolean,
): GatewayDeliveryClassification {
  switch (cacheStatus) {
    case "HIT":
      return { source: "cache-fresh", refresh: "not-attempted" };
    case "STALE":
      return { source: "cache-stale", refresh: "failed" };
    case "UPDATING":
      return { source: "cache-stale", refresh: "in-background" };
    case "MISS":
    case "EXPIRED":
    case "REVALIDATED":
      return { source: "live", refresh: failed ? "failed" : "succeeded" };
    case "BYPASS":
      return { source: "live", refresh: failed ? "failed" : "not-attempted" };
  }
}
