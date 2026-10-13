import { CATALOG_DATA_IDENTITY } from "./generated-catalog-identity.js";

const encoder = new TextEncoder();

export const CACHE_POLICY_VERSION = "central-market-cache-policy:v1";

export { CATALOG_DATA_IDENTITY };

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The cache identity of one operation's result: the cache policy version, the catalog data this release ships, the
 * canonical document and the canonical variables. The catalog's identity is generated from its data
 * (`catalog-tools:generate`), so a release that changes item names or search stores every answer under new keys, and
 * the gateway and cache Worker bundles that import it change with it.
 */
export function operationResultIdentity(
  document: string,
  canonicalVariables: string,
  catalogIdentity: string = CATALOG_DATA_IDENTITY,
): Promise<string> {
  return sha256Hex(`${CACHE_POLICY_VERSION}\n${catalogIdentity}\n${document}\n${canonicalVariables}`);
}

export function syntheticGetKey(operationIdentity: string): string {
  return `https://central-market.cache/operations/${operationIdentity}`;
}
