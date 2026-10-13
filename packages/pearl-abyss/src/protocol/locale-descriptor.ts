/** Every item-name locale, English first, with the language a reader knows it by. */
export const PEARL_ABYSS_ITEM_LOCALE_DESCRIPTORS = [
  { locale: "EN", description: "English." },
  { locale: "DE", description: "German." },
  { locale: "FR", description: "French." },
  { locale: "ES_EU", description: "European Spanish." },
  { locale: "ES", description: "Latin American Spanish." },
  { locale: "JA", description: "Japanese." },
  { locale: "KO", description: "Korean." },
  { locale: "PT", description: "Portuguese." },
  { locale: "RU", description: "Russian." },
  { locale: "TH", description: "Thai." },
  { locale: "TR", description: "Turkish." },
  { locale: "ZH_TW", description: "Traditional Chinese, as used in Taiwan." },
] as const;

export type PearlAbyssItemLocale = (typeof PEARL_ABYSS_ITEM_LOCALE_DESCRIPTORS)[number]["locale"];

export const PEARL_ABYSS_ITEM_LOCALES = PEARL_ABYSS_ITEM_LOCALE_DESCRIPTORS.map(({ locale }) => locale);

/** Each locale's description, keyed by locale in descriptor order: the shape a GraphQL enum's documented values take. */
// SAFETY: PEARL_ABYSS_ITEM_LOCALE_DESCRIPTORS is exhaustive, and each entry contributes its description under its locale.
export const PEARL_ABYSS_ITEM_LOCALE_DESCRIPTIONS = Object.fromEntries(
  PEARL_ABYSS_ITEM_LOCALE_DESCRIPTORS.map(({ locale, description }) => [locale, { description }]),
) as Readonly<Record<PearlAbyssItemLocale, { readonly description: string }>>;
