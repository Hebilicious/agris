const encoder = new TextEncoder();

export const CACHE_POLICY_VERSION = "central-market-cache-policy:v1";

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function operationResultIdentity(document: string, canonicalVariables: string): Promise<string> {
  return sha256Hex(`${CACHE_POLICY_VERSION}\n${document}\n${canonicalVariables}`);
}

export function syntheticGetKey(operationIdentity: string): string {
  return `https://central-market.cache/operations/${operationIdentity}`;
}
