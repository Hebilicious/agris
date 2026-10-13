import type { APIRoute } from "astro";

import {
  DEMO,
  freshnessRowsOf,
  MAXIMUM_GATEWAY_REQUEST_BYTES,
  PUBLIC_DOCUMENT_LIMITS,
  SELF_HOSTED,
  type CacheFreshnessPolicy,
} from "../facts.ts";
import { durationOf } from "../figure/model.ts";
import { DEMO_GRAPHQL, DEMO_HEALTH, SITE_ORIGIN } from "../site.ts";

/**
 * `/llms.txt`, written at build time so its limits and cache windows are the ones `src/facts.ts` reads from the code,
 * not copies typed into a text file.
 */
/** "60 requests per minute", or with another noun, "120 per minute". */
const ratePhrase = ({ limit, period }: { limit: number; period: number }, noun = " requests") =>
  `${limit}${noun} per ${period === 60 ? "minute" : `${period} seconds`}`;
const perMinute = (rate: { limit: number; period: number }) => ratePhrase(rate);

/** A policy's windows in one line: "`MarketItem.orderBook`, `Market.registrations` 5 s; ...". */
const windowListOf = (policy: CacheFreshnessPolicy) =>
  freshnessRowsOf(policy)
    .map((row) => `${row.fields.map((field) => `\`${field}\``).join(", ")} ${durationOf(row.fresh)}`)
    .join("; ");
const defaults = SELF_HOSTED.cacheFreshness;
const neverStoredFields = [...defaults.neverStored]
  .sort()
  .map((coordinate) => `\`${coordinate}\``)
  .join(" and ");
const neverStored = neverStoredFields === "" ? "" : ` ${neverStoredFields} are never stored.`;
const demoShortest = Math.min(...freshnessRowsOf(DEMO.cacheFreshness).map((row) => row.fresh));
const { maxDepth, maxFields, maxAliases } = PUBLIC_DOCUMENT_LIMITS;
const demoGlobal =
  DEMO.globalRateLimit === null ? "" : ` and ${ratePhrase(DEMO.globalRateLimit, "")} per Cloudflare location`;
const demoMarket =
  DEMO.marketClientLimit === null
    ? ""
    : `, and to ${ratePhrase(DEMO.marketClientLimit, " queries")} per IP that read the Central Market, counted exactly`;

const TEXT = `# Agris

> Agris is a free and open-source (MIT), read-only, federated GraphQL API over the Black Desert Online Central Market. It runs as Cloudflare Workers that you deploy to your own Cloudflare account: a gateway running Hive Gateway over an Apollo Federation v2 supergraph with its own cache Worker, plus a catalog subgraph and a market subgraph reached over Service Bindings. It serves prices, stock, order books, price history, hot items and the registration queue for 12 market regions, joined with item names in 12 languages and an item-name search.

Use Agris by deploying your own copy. It answers on \`agris.<subdomain>.workers.dev\` by default, and on any custom domain or route you add. The hosted demo API (${DEMO_GRAPHQL}, health check at ${DEMO_HEALTH}) is a shared courtesy instance limited to ${perMinute(DEMO.clientRateLimit)} per IP${demoGlobal}${demoMarket}, with long cache times; it may be rate limited or switched off at any time. Do not point an application, agent workflow, scheduled job or bulk export at it. This website (${SITE_ORIGIN}) is static documentation on its own origin and serves no API.

Key facts:

- Endpoint: \`POST /graphql\` with JSON \`{query, variables, operationName}\`, or \`GET /graphql?query=...\`, on the gateway's own origin. Persisted queries: \`GET /graphql?id=<sha256>&variables=<json>\`. Health check: \`GET /health\`. A browser opening \`/graphql\`, or a \`/graphql?query=\` link, gets GraphiQL. Responses carry CORS headers, so a web page on any origin can call a gateway directly.
- Queries only. Mutations and subscriptions are rejected. A public query may nest ${maxDepth} fields deep, select ${maxFields} fields and use ${maxAliases} aliases, in a body of at most ${MAXIMUM_GATEWAY_REQUEST_BYTES / 1_024} KiB; \`429\` with \`Retry-After\` means you were rate limited.
- Caching: each cached field has a freshness window and a response takes the shortest it selects. A self-hosted gateway's defaults: ${windowListOf(defaults)}.${neverStored} A stored answer may be served for ${durationOf(defaults.staleIfErrorSeconds)} while refreshes fail. Every deployment can change these, or turn caching off, in the gateway's settings (see the deploy guide). The cache key is the canonical query plus canonical variables, so the same query with different whitespace, comments or variable key order shares an entry. The shared demo keeps every stored answer for at least ${durationOf(demoShortest)}.
- Item IDs are the game's numeric item IDs, passed as GraphQL \`ID\` strings.
- Regions: EU, NA, ASIA, MENA, KR, RU, JP, TW, SA, CONSOLE_EU, CONSOLE_NA, CONSOLE_ASIA. Name locales: EN, DE, FR, ES, ES_EU, PT, RU, TR, JA, KO, TH, ZH_TW.
- ${SELF_HOSTED.clientRateLimit === null ? "A self-hosted gateway sets no per-IP rate limit by default; its deployer can turn one on" : `A self-hosted gateway allows ${perMinute(SELF_HOSTED.clientRateLimit)} per IP by default`}. The default settings deploy on the Cloudflare Workers Free plan; a paid plan lets the deployer raise the subrequest limit.
- Stack: Apollo Federation v2 subgraphs built with Pothos and served by GraphQL Yoga, composed with GraphQL Mesh Compose and executed by Hive Gateway inside a Cloudflare Worker, which runs any Envelop plugin added to the gateway's plugin list; Service Bindings, one Durable Object per Pearl Abyss host, Workers rate limiting, an optional Durable Object token bucket per client for queries that read the Central Market, and the Workers cache; TypeScript, XState, Effect and Effect Schema; Alchemy for deploys; moon, proto, pnpm, oxlint, oxfmt, Vitest with the Workers pool, Gherkin features and an Astro site.
- License: MIT. No account, no API key, no tracking.
- Agris is unofficial and not affiliated with Pearl Abyss or Arsha.

## Docs

- [README](https://github.com/Hebilicious/agris/blob/main/README.md): what Agris is, quickstart, configuration table
- [Deploy guide](https://github.com/Hebilicious/agris/blob/main/docs/deploy.md): deploy to your Cloudflare account, hostnames, rate limiting, every setting, costs
- [API reference](https://github.com/Hebilicious/agris/blob/main/docs/api.md): requests, persisted queries, errors, limits, caching headers
- [Architecture](https://github.com/Hebilicious/agris/blob/main/docs/architecture.md): gateway, subgraphs, Pearl Abyss coordination, Service Binding entrypoints
- [Client schema (SDL)](https://github.com/Hebilicious/agris/blob/main/tools/schema/artifacts/client-schema.graphql): the full public GraphQL schema

## Agents

- [AGENTS.md](https://github.com/Hebilicious/agris/blob/main/AGENTS.md): repository layout, commands and conventions for coding agents
- [deploy-agris skill](https://github.com/Hebilicious/agris/blob/main/.agents/skills/deploy-agris/SKILL.md): step-by-step self-hosting for an agent acting for a user

## Optional

- [Persisted operations](https://github.com/Hebilicious/agris/blob/main/tools/schema/artifacts/persisted-operations.json): the operation manifest with SHA-256 IDs
- [Research notes](https://github.com/Hebilicious/agris/tree/main/docs/research): Pearl Abyss endpoints, catalog maintenance, search index design
`;

export const GET: APIRoute = () => new Response(TEXT, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
