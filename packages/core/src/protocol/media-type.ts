/** The media type of every GraphQL answer Agris builds. */
export const GRAPHQL_RESPONSE_MEDIA_TYPE = "application/graphql-response+json";
/** The media type a legacy client, which predates GraphQL over HTTP, asks for. */
export const LEGACY_JSON_MEDIA_TYPE = "application/json";

export type GraphqlResponseMediaType = typeof GRAPHQL_RESPONSE_MEDIA_TYPE | typeof LEGACY_JSON_MEDIA_TYPE;

/**
 * The media type a successful answer is labelled with, for a request's `Accept` header (GraphQL over HTTP, section
 * 5.1). `application/json` only when the client prefers it to `application/graphql-response+json`, by RFC 9110
 * quality values, with the most specific media range deciding each type's quality; a tie, an absent or unreadable
 * header, or a header naming neither type keeps `application/graphql-response+json`. Only a `2xx` answer takes the
 * legacy label: a request error stays `application/graphql-response+json`, as the specification asks.
 */
export function negotiateGraphqlResponseMediaType(accept: string | null): GraphqlResponseMediaType {
  if (accept === null) return GRAPHQL_RESPONSE_MEDIA_TYPE;
  const ranges = accept.split(",").flatMap((part) => {
    const range = mediaRange(part);
    return range === undefined ? [] : [range];
  });
  const graphqlQuality = qualityOf(ranges, "application", "graphql-response+json");
  const jsonQuality = qualityOf(ranges, "application", "json");
  return jsonQuality > graphqlQuality ? LEGACY_JSON_MEDIA_TYPE : GRAPHQL_RESPONSE_MEDIA_TYPE;
}

interface MediaRange {
  readonly type: string;
  readonly subtype: string;
  readonly quality: number;
}

function mediaRange(text: string): MediaRange | undefined {
  const [name, ...parameters] = text.split(";").map((part) => part.trim().toLowerCase());
  const match = /^([a-z0-9!#$%&'*+.^_`|~-]+)\/([a-z0-9!#$%&'*+.^_`|~-]+)$/u.exec(name ?? "");
  if (match === null) return undefined;
  const [, type, subtype] = match;
  if (type === undefined || subtype === undefined) return undefined;
  let quality = 1;
  for (const parameter of parameters) {
    const weight = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.exec(parameter);
    if (weight?.[1] !== undefined) quality = Number(weight[1]);
  }
  return { type, subtype, quality };
}

/** The quality of the most specific range matching `type/subtype`; 0 when no range matches. */
function qualityOf(ranges: readonly MediaRange[], type: string, subtype: string): number {
  let specificity = -1;
  let quality = 0;
  for (const range of ranges) {
    const rangeSpecificity =
      range.type === type && range.subtype === subtype
        ? 2
        : range.type === type && range.subtype === "*"
          ? 1
          : range.type === "*" && range.subtype === "*"
            ? 0
            : -1;
    if (rangeSpecificity > specificity) {
      specificity = rangeSpecificity;
      quality = range.quality;
    }
  }
  return quality;
}
