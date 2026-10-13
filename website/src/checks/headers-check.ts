/**
 * The site's response headers, checked on the build by `moon run website:headers-check`:
 *
 * - `_headers` sends every security header on every path, with the values the site promises;
 * - its Content Security Policy allows every inline script and style element the built pages hold, by hash;
 * - the pages load scripts, stylesheets, fonts, images and the manifest from the site's own origin only, and use no
 *   inline event handlers, which the policy would block;
 * - the Run panels' requests to the demo API are allowed.
 *
 * It exits non-zero with every problem listed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { inlineSourcesOf } from "../security-headers.ts";
import { DEMO_API_ORIGIN } from "../site.ts";

const dist = process.argv[2];
if (dist === undefined) {
  console.error("usage: headers-check <built site directory>");
  process.exit(2);
}

const problems: string[] = [];

/** The `/*` rule's headers, by lower-case name. */
function headersOf(file: string): Map<string, string> {
  const headers = new Map<string, string>();
  let inRule = false;
  for (const line of file.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      inRule = line.trim() === "/*";
      continue;
    }
    const match = /^\s+([^:]+):\s*(.*)$/.exec(line);
    if (inRule && match !== null) headers.set(match[1]!.toLowerCase(), match[2]!);
  }
  return headers;
}

const headersFile = join(dist, "_headers");
if (!existsSync(headersFile)) {
  console.error(`${headersFile} is missing: the site build writes it (src/security-headers.ts).`);
  process.exit(1);
}
const headers = headersOf(readFileSync(headersFile, "utf8"));
const expected: ReadonlyArray<readonly [string, string]> = [
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
];
for (const [name, value] of expected) {
  if (headers.get(name) !== value) problems.push(`${name} is ${headers.get(name) ?? "missing"}, not ${value}`);
}
if (!headers.has("permissions-policy")) problems.push("permissions-policy is missing");

const policy = new Map<string, string[]>();
for (const directive of (headers.get("content-security-policy") ?? "").split(";")) {
  const [name, ...sources] = directive.trim().split(/\s+/);
  if (name !== undefined && name !== "") policy.set(name, sources);
}
const sourcesOf = (name: string) => policy.get(name) ?? policy.get("default-src") ?? [];
if (policy.size === 0) problems.push("content-security-policy is missing");
if (sourcesOf("default-src").join(" ") !== "'none'") problems.push("default-src is not 'none'");
if (sourcesOf("frame-ancestors").join(" ") !== "'none'") problems.push("frame-ancestors is not 'none'");
if (!sourcesOf("connect-src").includes(DEMO_API_ORIGIN)) problems.push(`connect-src does not allow ${DEMO_API_ORIGIN}`);
for (const name of ["script-src", "style-src-elem"]) {
  if (sourcesOf(name).some((source) => source === "'unsafe-inline'" || source === "*"))
    problems.push(`${name} allows any inline or any origin`);
}

const pageFiles = readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".html"));
const pages = pageFiles.map((file) => readFileSync(join(dist, file), "utf8"));
const inline = inlineSourcesOf(pages);
for (const hash of inline.scripts) {
  if (!sourcesOf("script-src").includes(hash)) problems.push(`script-src does not allow an inline script ${hash}`);
}
for (const hash of inline.styles) {
  if (!sourcesOf("style-src-elem").includes(hash))
    problems.push(`style-src-elem does not allow an inline style ${hash}`);
}

/** URLs a page loads from a script, an image or a picture source; links are checked on their own. */
const RESOURCE = /<(?:script|img|source)\b[^>]*?\s(?:src|srcset)="([^"]*)"/g;
pages.forEach((html, index) => {
  for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
    if (/\srel="(?:alternate|canonical)"/.test(tag)) continue;
    const href = /\shref="([^"]*)"/.exec(tag)?.[1] ?? "";
    if (/^(?:https?:)?\/\//.test(href))
      problems.push(`${pageFiles[index]} links a resource on another origin: ${href}`);
  }
  for (const [, url = ""] of html.matchAll(RESOURCE)) {
    for (const candidate of url.split(",").map((entry) => entry.trim().split(/\s+/)[0] ?? "")) {
      if (/^(?:https?:)?\/\//.test(candidate) || candidate.startsWith("data:"))
        problems.push(`${pageFiles[index]} loads ${candidate.slice(0, 80)} from another origin`);
    }
  }
  for (const [handler] of html.matchAll(/<[a-z][^>]*\son[a-z]+="/gi)) {
    problems.push(`${pageFiles[index]} has an inline event handler: ${handler.slice(0, 80)}`);
  }
});

if (problems.length > 0) {
  console.error(`${problems.length} header problem(s) in ${dist}:\n${problems.map((line) => `  ${line}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `${pageFiles.length} page(s) checked against ${join(dist, "_headers")}: every security header is set, the policy allows ${inline.scripts.length} inline script(s) and ${inline.styles.length} inline style(s) by hash, and every resource is on the site's own origin.`,
);
