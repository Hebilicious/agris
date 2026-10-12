export const PEARL_ABYSS_ITEM_LOCALE_DESCRIPTORS = [
  { locale: "EN" },
  { locale: "DE" },
  { locale: "FR" },
  { locale: "ES_EU" },
  { locale: "ES" },
  { locale: "JA" },
  { locale: "KO" },
  { locale: "PT" },
  { locale: "RU" },
  { locale: "TH" },
  { locale: "TR" },
  { locale: "ZH_TW" },
] as const;

export type PearlAbyssItemLocale = (typeof PEARL_ABYSS_ITEM_LOCALE_DESCRIPTORS)[number]["locale"];

export const PEARL_ABYSS_ITEM_LOCALES = PEARL_ABYSS_ITEM_LOCALE_DESCRIPTORS.map(({ locale }) => locale);
