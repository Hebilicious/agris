import type {
  GatewayResponseClassification,
  GatewayResponseClassificationInput,
  GatewayResponseRefresh,
  GatewayResponseSource,
} from "./types.js";

interface GatewayDeliveryClassification {
  readonly source: GatewayResponseSource;
  readonly refresh: GatewayResponseRefresh;
}

export function classifyGatewayResponse(input: GatewayResponseClassificationInput): GatewayResponseClassification {
  const failed = input.hasGraphqlErrors || input.totalUpstreamUnavailable;
  const delivery = classifyDelivery(input.cacheStatus, failed);
  return {
    status: input.totalUpstreamUnavailable ? 503 : 200,
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
