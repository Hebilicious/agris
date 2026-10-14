/** Addresses the site links to. Every external link opens in a new tab with `rel="noopener noreferrer"`. */
export const REPOSITORY = "https://github.com/Hebilicious/agris";
export const ISSUES = `${REPOSITORY}/issues`;
export const PULL_REQUESTS = `${REPOSITORY}/pulls`;
/** The credits live in the README; the site links there rather than repeating them. */
export const README_CREDITS = `${REPOSITORY}#credits`;
export const ENVELOP_PLUGINS = "https://the-guild.dev/graphql/envelop/plugins";

/** The proto version `.prototools` pins; a test holds every install instruction to it. */
export const PROTO_VERSION = "0.63.1";
/** proto's own installer from that release, which checks the SHA-256 of the build it downloads. */
export const PROTO_INSTALLER = `https://github.com/moonrepo/proto/releases/download/v${PROTO_VERSION}/proto_cli-installer.sh`;

/** Where this site is published: static files only, with no API behind them. */
export const SITE_ORIGIN = "https://agris-docs.hebilicious.workers.dev";

/**
 * The shared demo API, on its own origin. Every GraphiQL link, example and in-page request goes here; nothing on the
 * site assumes the API answers on the site's own origin. It sends CORS headers, so a page may also fetch from it.
 */
export const DEMO_API_ORIGIN = "https://agris-demo.hebilicious.workers.dev";
export const DEMO_GRAPHQL = `${DEMO_API_ORIGIN}/graphql`;
export const DEMO_HEALTH = `${DEMO_API_ORIGIN}/health`;

/** A link that opens GraphiQL on the demo with `query` in the editor. */
export function demoGraphiqlLink(query: string): string {
  return `${DEMO_GRAPHQL}?query=${encodeURIComponent(query)}`;
}

/** Attributes for a link that leaves the page: a new tab, with no opener and no referrer. */
export const NEW_TAB = { target: "_blank", rel: "noopener noreferrer" } as const;
