import { normalizeCountyKey } from "./countyIpnsRegistry.ts";

const CID_V0_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/u;

/**
 * Parse a strict county→CID fallback map.
 *
 * These maps are intentionally separate from stable IPNS maps. A caller first
 * resolves IPNS, then uses the reviewed immutable CID only when that gateway
 * is stale or unavailable.
 *
 * @param raw - JSON object mapping county names to CIDv0 strings.
 * @param envName - Environment variable name used in validation errors.
 * @returns Normalized county keys mapped to validated immutable CIDs.
 * @throws {Error} When the configured JSON or a CID is invalid.
 */
export function parseCountyCidFallbackMap(
  raw: string | undefined,
  envName: string,
): Record<string, string> {
  if (raw === undefined || raw.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${envName} contains invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${envName} must be a JSON object`);
  }

  const result: Record<string, string> = {};
  for (const [county, rawCid] of Object.entries(parsed)) {
    const countyKey = normalizeCountyKey(county);
    if (countyKey === "") {
      throw new Error(`${envName} contains a blank county key`);
    }
    if (typeof rawCid !== "string" || !CID_V0_PATTERN.test(rawCid.trim())) {
      throw new Error(
        `${envName} entry '${countyKey}' must be a valid CIDv0 string`,
      );
    }
    result[countyKey] = rawCid.trim();
  }
  return result;
}

/**
 * Extract a bare IPNS name from a path- or subdomain-gateway URL.
 *
 * @param location - Configured stable query-table URL.
 * @returns Bare k51… name, or null when the URL is not an IPNS path.
 */
export function extractIpnsName(location: string): string | null {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  const pathMatch = /^\/ipns\/([^/]+)(?:\/|$)/u.exec(url.pathname);
  if (pathMatch?.[1] !== undefined) return pathMatch[1];

  const hostnameMatch = /^([^.]+)\.ipns\./u.exec(url.hostname);
  return hostnameMatch?.[1] ?? null;
}

/**
 * Build the direct immutable Filebase path used only as a reviewed fallback.
 *
 * @param cid - Validated immutable CID.
 * @returns Public HTTPS content-CID URL.
 */
export function filebaseCidUrl(cid: string): string {
  return `https://ipfs.filebase.io/ipfs/${cid}`;
}
