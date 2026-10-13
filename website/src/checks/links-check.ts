/**
 * The site's link rules, checked on the built page by `moon run website:links-check`:
 *
 * - every link that leaves the page (another origin) opens in a new tab with `rel="noopener noreferrer"`;
 * - no link points at a file in the repository (`/blob/`, `/tree/`, `/raw/`): the site explains in words and
 *   sends readers to the repository, its issues or its pull requests;
 * - no link reaches the API by a path on the site's own origin (`/graphql`, `/health`): the site is static files on
 *   one origin and the demo API lives on another, so those links go to the demo's absolute URL.
 *
 * It reads the HTML as text and exits non-zero with every offending link listed.
 */
import { readFileSync } from "node:fs";

const page = process.argv[2];
if (page === undefined) {
  console.error("usage: links-check <built page>");
  process.exit(2);
}

const html = readFileSync(page, "utf8");
const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((match) => match[0]);
const attribute = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

const problems: string[] = [];
let outbound = 0;
for (const tag of anchors) {
  const href = attribute(tag, "href") ?? "";
  const leaves = /^https?:\/\//.test(href);
  if (/\/(blob|tree|raw)\//.test(href)) problems.push(`links to a repository file: ${href}`);
  if (/^\/(graphql|health)\b/.test(href))
    problems.push(`links to the API on the site's own origin: ${href.slice(0, 80)}`);
  if (!leaves) continue;
  outbound += 1;
  const rel = (attribute(tag, "rel") ?? "").split(/\s+/);
  if (attribute(tag, "target") !== "_blank" || !rel.includes("noopener") || !rel.includes("noreferrer"))
    problems.push(`does not open in a new tab with rel="noopener noreferrer": ${href.slice(0, 80)}`);
}

if (problems.length > 0) {
  console.error(`${problems.length} link problem(s) in ${page}:\n${problems.map((line) => `  ${line}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `${outbound} outbound links checked in ${page}: all open in a new tab, none points at a repository file, and none reaches the API on the site's own origin.`,
);
