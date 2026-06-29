import { logger } from "../logger.ts";

/**
 * County → IPNS registry resolution.
 *
 * A single MCP deployment can serve open data for several counties, each
 * published under its own IPNS name. The registry is supplied as a JSON object
 * env var (e.g. ORACLE_OPEN_DATA_IPNS_MAP) keyed by normalized county name:
 *
 *   {"lee":"k51…lee","palm-beach":"k51…pb"}
 *
 * When the map is unset/empty the resolver falls back to the legacy single-IPNS
 * env var so existing single-county deployments keep working unchanged.
 */

/**
 * Normalize a county name to its registry-key form: trimmed, lowercased, with
 * internal whitespace collapsed to single hyphens (e.g. "Palm Beach" →
 * "palm-beach", "Lee" → "lee").
 */
export function normalizeCountyKey(county: string): string {
  return county.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Parse a county → IPNS JSON map from a raw env var value. Returns an empty map
 * when the value is unset, blank, or malformed (the failure is logged so a bad
 * deployment config is visible without crashing the server). Keys are
 * normalized via {@link normalizeCountyKey}; entries with non-string/blank IPNS
 * values are skipped.
 */
export function parseCountyIpnsMap(
  raw: string | undefined,
): Record<string, string> {
  if (!raw || raw.trim() === "") {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to parse county→IPNS map JSON — ignoring (falling back to single IPNS)",
    );
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    logger.warn("County→IPNS map is not a JSON object — ignoring");
    return {};
  }

  const map: Record<string, string> = {};
  for (const [county, ipns] of Object.entries(parsed)) {
    if (typeof ipns !== "string" || ipns.trim() === "") {
      logger.warn(
        { county },
        "Skipping county→IPNS entry with a non-string/blank IPNS value",
      );
      continue;
    }
    map[normalizeCountyKey(county)] = ipns.trim();
  }

  return map;
}

/** The env contract for one dataset's county→IPNS registry. */
export interface CountyIpnsEnv {
  /** Raw JSON map value (e.g. ORACLE_OPEN_DATA_IPNS_MAP). */
  map: string | undefined;
  /** Legacy single-IPNS value (e.g. ORACLE_OPEN_DATA_IPNS). */
  singleIpns: string | undefined;
  /** Optional default-county name (e.g. ORACLE_OPEN_DATA_DEFAULT_COUNTY). */
  defaultCounty: string | undefined;
}

/** Outcome of resolving a requested county against the registry. */
export interface CountyIpnsResolution {
  /** The IPNS name to resolve to a CID, or null when none applies. */
  ipnsName: string | null;
  /** Whether this county is served by this deployment. false → empty result. */
  served: boolean;
  /**
   * Whether a fixed-CID fallback (env CID / built-in default) is permitted when
   * the IPNS resolution yields nothing. Only true for the legacy/default county
   * so a non-default county never accidentally serves the default county's data.
   */
  allowFixedFallback: boolean;
  /** The normalized county key that was resolved (null when none requested). */
  countyKey: string | null;
}

/**
 * Resolve a requested county to the IPNS name that should be read for it.
 *
 * Behaviour:
 * - No registry map configured (legacy mode): always resolve to the single
 *   IPNS with fixed-CID fallback, regardless of the requested county. The
 *   caller's post-fetch county guard filters mismatches, preserving the
 *   original single-county behaviour exactly.
 * - Registry map configured (multi-county mode):
 *   - county in the map → that county's IPNS (no fixed-CID fallback).
 *   - county equals the configured default county → legacy single IPNS + fixed
 *     fallback.
 *   - no county requested and no default county → legacy single IPNS + fixed
 *     fallback.
 *   - otherwise → not served (caller returns an empty/unknown-county result).
 */
export function resolveCountyIpns(
  county: string | undefined,
  env: CountyIpnsEnv,
): CountyIpnsResolution {
  const map = parseCountyIpnsMap(env.map);
  const singleIpns = env.singleIpns?.trim() || null;
  const defaultCountyKey = env.defaultCounty
    ? normalizeCountyKey(env.defaultCounty)
    : null;
  const requestedKey = county ? normalizeCountyKey(county) : defaultCountyKey;

  // Legacy mode: no registry → behave exactly as the single-IPNS deployment.
  if (Object.keys(map).length === 0) {
    return {
      ipnsName: singleIpns,
      served: true,
      allowFixedFallback: true,
      countyKey: requestedKey,
    };
  }

  // Multi-county mode with no county and no default → legacy single IPNS.
  if (requestedKey === null) {
    return {
      ipnsName: singleIpns,
      served: true,
      allowFixedFallback: true,
      countyKey: null,
    };
  }

  // County is explicitly registered.
  const mappedIpns = map[requestedKey];
  if (mappedIpns !== undefined) {
    return {
      ipnsName: mappedIpns,
      served: true,
      allowFixedFallback: false,
      countyKey: requestedKey,
    };
  }

  // County is the configured default → legacy single IPNS + fixed fallback.
  if (defaultCountyKey !== null && requestedKey === defaultCountyKey) {
    return {
      ipnsName: singleIpns,
      served: true,
      allowFixedFallback: true,
      countyKey: requestedKey,
    };
  }

  // Unknown county under a configured registry.
  return {
    ipnsName: null,
    served: false,
    allowFixedFallback: false,
    countyKey: requestedKey,
  };
}
