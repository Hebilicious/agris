export const PEARL_ABYSS_REGIONS = [
  { code: "EU", slug: "eu", host: "eu-trade.naeu.playblackdesert.com" },
  { code: "NA", slug: "na", host: "na-trade.naeu.playblackdesert.com" },
  { code: "ASIA", slug: "asia", host: "asia-trade.blackdesert.pearlabyss.com" },
  { code: "MENA", slug: "mena", host: "tr-trade.blackdesert.pearlabyss.com" },
  { code: "KR", slug: "kr", host: "trade.kr.playblackdesert.com" },
  { code: "RU", slug: "ru", host: "trade.ru.playblackdesert.com" },
  { code: "JP", slug: "jp", host: "trade.jp.playblackdesert.com" },
  { code: "TW", slug: "tw", host: "trade.tw.playblackdesert.com" },
  { code: "SA", slug: "sa", host: "trade.sa.playblackdesert.com" },
  { code: "CONSOLE_EU", slug: "console_eu", host: "console-eu-trade.blackdesert.pearlabyss.com" },
  { code: "CONSOLE_NA", slug: "console_na", host: "console-na-trade.blackdesert.pearlabyss.com" },
  { code: "CONSOLE_ASIA", slug: "console_asia", host: "console-asia-trade.blackdesert.pearlabyss.com" },
] as const;

export type PearlAbyssRegion = (typeof PEARL_ABYSS_REGIONS)[number]["code"];
export type PearlAbyssRegionSlug = (typeof PEARL_ABYSS_REGIONS)[number]["slug"];
