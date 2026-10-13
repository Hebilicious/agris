/**
 * The site's response headers, written at build time to `dist/_headers`, which the Workers asset layer applies to
 * every file it serves (Alchemy folds the file into the docs Worker's asset configuration; it is not served itself).
 *
 * The Content Security Policy allows only what the built site uses: its own scripts, stylesheets, fonts, images and
 * manifest, `fetch` to the demo API for the Run panels, and inline `style` attributes, which the code highlighting
 * and Fig 1 write. An inline `<script>` or `<style>` element is allowed only by the SHA-256 of its text, which the
 * build computes from the pages it wrote, so a later build that inlines a small script keeps working and nothing else
 * inline runs. JSON data blocks are not script and need no hash.
 */
import { createHash } from "node:crypto";

import { DEMO_API_ORIGIN } from "./site.ts";

/** The inline elements of a set of pages that the policy must allow, as CSP hash sources. */
export interface InlineSources {
  readonly scripts: readonly string[];
  readonly styles: readonly string[];
}

/** Script types a browser runs; any other `type` (such as `application/json`) is data. */
const EXECUTABLE_SCRIPT_TYPES = new Set(["", "module", "text/javascript", "application/javascript"]);

const hashSourceOf = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const typeOf = (attributes: string) => /\stype="([^"]*)"/.exec(attributes)?.[1]?.toLowerCase() ?? "";

/** The hash sources of every inline script and style element in `pages`. */
export function inlineSourcesOf(pages: readonly string[]): InlineSources {
  const scripts = new Set<string>();
  const styles = new Set<string>();
  for (const html of pages) {
    for (const [, attributes = "", text = ""] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/\ssrc=/.test(attributes) || !EXECUTABLE_SCRIPT_TYPES.has(typeOf(attributes))) continue;
      scripts.add(hashSourceOf(text));
    }
    for (const [, text = ""] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) styles.add(hashSourceOf(text));
  }
  return { scripts: [...scripts].sort(), styles: [...styles].sort() };
}

/** The Content-Security-Policy value for pages with these inline elements. */
export function contentSecurityPolicyOf(inline: InlineSources): string {
  const directives: ReadonlyArray<readonly [string, ...string[]]> = [
    ["default-src", "'none'"],
    ["script-src", "'self'", ...inline.scripts],
    // `style-src` is the fallback for browsers without the two directives after it, which need inline attributes.
    ["style-src", "'self'", "'unsafe-inline'"],
    ["style-src-elem", "'self'", ...inline.styles],
    ["style-src-attr", "'unsafe-inline'"],
    ["img-src", "'self'"],
    ["font-src", "'self'"],
    ["manifest-src", "'self'"],
    ["connect-src", DEMO_API_ORIGIN],
    ["base-uri", "'none'"],
    ["form-action", "'none'"],
    ["frame-ancestors", "'none'"],
  ];
  return directives.map((directive) => directive.join(" ")).join("; ");
}

/** Browser features the site never uses, turned off for it and for anything that might embed it. */
const PERMISSIONS_POLICY = [
  "accelerometer",
  "autoplay",
  "browsing-topics",
  "camera",
  "display-capture",
  "geolocation",
  "gyroscope",
  "magnetometer",
  "microphone",
  "midi",
  "payment",
  "publickey-credentials-get",
  "usb",
]
  .map((feature) => `${feature}=()`)
  .join(", ");

/** Every header the site sends, by name. */
export function securityHeadersOf(inline: InlineSources): ReadonlyArray<readonly [string, string]> {
  return [
    ["Content-Security-Policy", contentSecurityPolicyOf(inline)],
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
    ["Permissions-Policy", PERMISSIONS_POLICY],
    ["Cross-Origin-Opener-Policy", "same-origin"],
  ];
}

/** The `_headers` file: the security headers on every path. */
export function headersFileOf(inline: InlineSources): string {
  const lines = securityHeadersOf(inline).map(([name, value]) => `  ${name}: ${value}`);
  return ["# Written by the site build (src/security-headers.ts); do not edit.", "/*", ...lines, ""].join("\n");
}
