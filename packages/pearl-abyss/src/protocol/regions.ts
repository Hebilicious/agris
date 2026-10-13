import { PEARL_ABYSS_REGIONS, type PearlAbyssRegion } from "./region-descriptor.js";

// SAFETY: PEARL_ABYSS_REGIONS is exhaustive, and each entry contributes its hostname under its region code.
export const PEARL_ABYSS_REGION_HOSTS = Object.fromEntries(
  PEARL_ABYSS_REGIONS.map(({ code, host }) => [code, host]),
) as Readonly<Record<PearlAbyssRegion, string>>;
