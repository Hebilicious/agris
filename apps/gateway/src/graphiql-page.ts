import { renderGraphiQL } from "graphql-yoga";

import { AGRIS_FAVICON_URL } from "./graphiql-favicon.js";

/**
 * The public gateway's GraphiQL page: Yoga's page with Agris's icon and example query, served with the
 * Content-Security-Policy it needs and no more.
 */

const GRAPHQL_PATH = "/graphql";

const GRAPHIQL_DEFAULT_QUERY = `# Prices and names for two items on the EU market.
query Prices {
  market(region: EU) {
    observedAt
    items(ids: ["44195", "10006"]) {
      item { id name }
      basePrice
      currentStock
    }
  }
}
`;

// Yoga's GraphiQL page takes its `query` option over the URL's `?query=`, and its own welcome comment when neither is
// set; its `defaultQuery` never reaches the editor. So the example query is passed only when the link carries none.
// `GraphiQLOptions` does not declare `query`, so the options are a named object rather than a literal.
const GRAPHIQL_OPTIONS = { title: "Agris GraphiQL", endpoint: GRAPHQL_PATH, favicon: AGRIS_FAVICON_URL };
const GRAPHIQL_OPTIONS_WITH_EXAMPLE = { ...GRAPHIQL_OPTIONS, query: GRAPHIQL_DEFAULT_QUERY };

/** Yoga's page template links its own icon whatever the `favicon` option says, so the page's icon link is replaced. */
const YOGA_ICON_LINK = /<link rel=icon href=[^>]*>/u;
const AGRIS_ICON_LINK = `<link rel=icon type="image/svg+xml" href="${AGRIS_FAVICON_URL}">`;

/** Where Yoga's page loads GraphiQL from: one pinned release on unpkg, whose `dist/` directory the policy allows. */
const GRAPHIQL_RELEASE = /https:\/\/unpkg\.com\/@graphql-yoga\/graphiql@[0-9]+\.[0-9]+\.[0-9]+\/dist\//u;
/**
 * An inline script: a `<script>` tag, with or without attributes, that has no `src` attribute. `src` must follow
 * whitespace, so an attribute such as `data-src` does not count as one.
 */
const INLINE_SCRIPT = /<script\b(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/giu;

/** One rendered GraphiQL page and the policy it is served with. */
export interface GraphiqlPage {
  readonly html: string;
  readonly contentSecurityPolicy: string;
}

/**
 * Rendered pages, one per key, each rendered on first use. A render that fails is forgotten, so the next request
 * renders the page again instead of failing for the isolate's life.
 */
export class RenderedPages<Key> {
  private readonly pages = new Map<Key, Promise<GraphiqlPage>>();
  private readonly render: (key: Key) => Promise<GraphiqlPage>;

  public constructor(render: (key: Key) => Promise<GraphiqlPage>) {
    this.render = render;
  }

  public get(key: Key): Promise<GraphiqlPage> {
    const existing = this.pages.get(key);
    if (existing !== undefined) return existing;
    const rendered = this.render(key);
    this.pages.set(key, rendered);
    rendered.catch(() => {
      if (this.pages.get(key) === rendered) this.pages.delete(key);
    });
    return rendered;
  }
}

/** The two GraphiQL pages, with and without the example query. */
const graphiqlPages = new RenderedPages(renderGraphiqlPage);

/** The GraphiQL page for a browser at `url`: with the example query unless the link carries its own. */
export async function graphiqlPage(url: URL): Promise<Response> {
  const page = await graphiqlPages.get(!url.searchParams.has("query"));
  return new Response(page.html, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": page.contentSecurityPolicy,
      "X-Frame-Options": "DENY",
    },
  });
}

async function renderGraphiqlPage(withExample: boolean): Promise<GraphiqlPage> {
  const html = renderGraphiQL(withExample ? GRAPHIQL_OPTIONS_WITH_EXAMPLE : GRAPHIQL_OPTIONS).replace(
    YOGA_ICON_LINK,
    AGRIS_ICON_LINK,
  );
  return { html, contentSecurityPolicy: await graphiqlContentSecurityPolicy(html) };
}

/**
 * The Content-Security-Policy a GraphiQL page needs and no more. Its inline scripts run by their hashes, and its only
 * third-party code is the pinned GraphiQL release on unpkg, which the page loads as a script and a stylesheet and whose
 * editor workers it fetches and starts from `blob:` URLs. The editor sets inline styles, and its fonts are `data:` URLs
 * inside the stylesheet. Nothing else may load, and no other site may frame the page.
 */
export async function graphiqlContentSecurityPolicy(html: string): Promise<string> {
  const release = GRAPHIQL_RELEASE.exec(html)?.[0];
  if (release === undefined) throw new TypeError("Yoga's GraphiQL page no longer loads a pinned release from unpkg");
  const scriptHashes = await Promise.all([...html.matchAll(INLINE_SCRIPT)].map(([, script]) => sha256Source(script)));
  const directives = [
    "default-src 'none'",
    `script-src ${[...scriptHashes, release].join(" ")}`,
    `style-src ${release} 'unsafe-inline'`,
    "font-src data:",
    "img-src 'self' data:",
    `connect-src 'self' ${release}monacoeditorwork/`,
    "worker-src blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ];
  return directives.join("; ");
}

/** A CSP hash source for one inline script. */
async function sha256Source(script: string | undefined): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script ?? ""));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}
