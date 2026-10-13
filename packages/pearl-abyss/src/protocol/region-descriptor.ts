/** Every Central Market region Agris reads: its public code, its slug, its Pearl Abyss host and a reader's name for it. */
export const PEARL_ABYSS_REGIONS = [
  { code: "EU", slug: "eu", host: "eu-trade.naeu.playblackdesert.com", description: "Europe (PC)." },
  { code: "NA", slug: "na", host: "na-trade.naeu.playblackdesert.com", description: "North America (PC)." },
  {
    code: "ASIA",
    slug: "asia",
    host: "asia-trade.blackdesert.pearlabyss.com",
    description: "Asia (PC), shared by South East Asia and Thailand.",
  },
  {
    code: "MENA",
    slug: "mena",
    host: "tr-trade.blackdesert.pearlabyss.com",
    description: "Middle East and North Africa (PC).",
  },
  { code: "KR", slug: "kr", host: "trade.kr.playblackdesert.com", description: "Korea (PC)." },
  { code: "RU", slug: "ru", host: "trade.ru.playblackdesert.com", description: "Russia (PC)." },
  { code: "JP", slug: "jp", host: "trade.jp.playblackdesert.com", description: "Japan (PC)." },
  { code: "TW", slug: "tw", host: "trade.tw.playblackdesert.com", description: "Taiwan (PC)." },
  { code: "SA", slug: "sa", host: "trade.sa.playblackdesert.com", description: "South America (PC)." },
  {
    code: "CONSOLE_EU",
    slug: "console_eu",
    host: "console-eu-trade.blackdesert.pearlabyss.com",
    description: "Europe (console).",
  },
  {
    code: "CONSOLE_NA",
    slug: "console_na",
    host: "console-na-trade.blackdesert.pearlabyss.com",
    description: "North America (console).",
  },
  {
    code: "CONSOLE_ASIA",
    slug: "console_asia",
    host: "console-asia-trade.blackdesert.pearlabyss.com",
    description: "Asia (console).",
  },
] as const;

export type PearlAbyssRegion = (typeof PEARL_ABYSS_REGIONS)[number]["code"];
export type PearlAbyssRegionSlug = (typeof PEARL_ABYSS_REGIONS)[number]["slug"];

/** Each region's description, keyed by code in descriptor order: the shape a GraphQL enum's documented values take. */
// SAFETY: PEARL_ABYSS_REGIONS is exhaustive, and each entry contributes its description under its region code.
export const PEARL_ABYSS_REGION_DESCRIPTIONS = Object.fromEntries(
  PEARL_ABYSS_REGIONS.map(({ code, description }) => [code, { description }]),
) as Readonly<Record<PearlAbyssRegion, { readonly description: string }>>;
