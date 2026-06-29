import { z } from "zod";
import { getJsonByCid } from "./ipfs.ts";
import { logger } from "../logger.ts";
import { resolveCountyIpns } from "./countyIpnsRegistry.ts";

/**
 * Derived geo/value index loader.
 *
 * This is a SEPARATE small dataset from the consolidated open-data manifest.
 * It is resolved exclusively through its OWN env vars
 * (ORACLE_GEO_INDEX_CID / ORACLE_GEO_INDEX_IPNS) and never reads or mutates the
 * ORACLE_OPEN_DATA_* vars, keeping the two datasets fully independent.
 */

export const GeoIndexEntrySchema = z.object({
  parcelIdentifier: z.string(),
  requestIdentifier: z.string(),
  folio: z.string().optional(),
  latitude: z.number(),
  longitude: z.number(),
  currentAvmValue: z.number().nullable(),
  propertyType: z.string().nullable(),
});
export type GeoIndexEntry = z.infer<typeof GeoIndexEntrySchema>;

export const GeoIndexSchema = z.object({
  county: z.string(),
  exportedAt: z.string().optional(),
  count: z.number().optional(),
  entries: z.array(GeoIndexEntrySchema),
});
export type GeoIndex = z.infer<typeof GeoIndexSchema>;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Per-endpoint deadline for IPNS gateway HEAD requests. Node's built-in fetch
// has no default timeout, so without this a hung gateway would stall every
// cache-miss request indefinitely.
const GATEWAY_TIMEOUT_MS = 12_000;

// Cache key used when no county (and no default county) is in play.
const DEFAULT_CACHE_KEY = "__default__";

interface GeoIndexCacheEntry {
  index: GeoIndex;
  fetchedAt: number;
}

// Per-county caches: the geo index can be published per county under its own
// IPNS (ORACLE_GEO_INDEX_IPNS_MAP), so cache keyed by resolved county.
const geoIndexCache = new Map<string, GeoIndexCacheEntry>();

/**
 * Resolve the geo index CID from ORACLE_GEO_INDEX_CID. Returns null when unset.
 * Intentionally does NOT fall back to any ORACLE_OPEN_DATA_* var.
 */
export function getGeoIndexCid(): string | null {
  return process.env.ORACLE_GEO_INDEX_CID ?? null;
}

export function clearGeoIndexCache(): void {
  geoIndexCache.clear();
}

/**
 * Resolve a geo index IPNS name to its current CID via public IPFS gateways,
 * reading the resolved root from the `x-ipfs-roots` header. Mirrors the
 * open-data manifest resolver but on the geo-specific vars.
 */
export async function resolveGeoIndexIpnsToCid(
  ipnsName: string,
): Promise<string | null> {
  if (!ipnsName) {
    return null;
  }

  const endpoints = [
    `https://${ipnsName}.ipns.dweb.link/`,
    `https://ipfs.filebase.io/ipns/${encodeURIComponent(ipnsName)}`,
  ];

  for (const url of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn(
          { url, status: response.status },
          "Geo index IPNS resolve endpoint returned non-2xx",
        );
        continue;
      }
      const roots = response.headers.get("x-ipfs-roots");
      if (roots) {
        const cid = roots
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .pop();
        if (cid) {
          return cid;
        }
      }
    } catch (err) {
      logger.warn(
        { url, error: err instanceof Error ? err.message : String(err) },
        "Geo index IPNS resolution failed for endpoint",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  logger.warn({ ipnsName }, "All geo index IPNS resolution endpoints failed");
  return null;
}

/**
 * Resolve the CID to read the geo index from for the given county. The county's
 * IPNS (from ORACLE_GEO_INDEX_IPNS_MAP, or the legacy single ORACLE_GEO_INDEX_IPNS)
 * is resolved to a CID; the fixed ORACLE_GEO_INDEX_CID is only used as a fallback
 * for the legacy/default county. Returns null when nothing is configured.
 */
async function resolveGeoIndexCid(county?: string): Promise<string | null> {
  const resolution = resolveCountyIpns(county, {
    map: process.env.ORACLE_GEO_INDEX_IPNS_MAP,
    singleIpns: process.env.ORACLE_GEO_INDEX_IPNS,
    defaultCounty: process.env.ORACLE_GEO_INDEX_DEFAULT_COUNTY,
  });
  if (!resolution.served) {
    return null;
  }

  if (resolution.ipnsName) {
    const cid = await resolveGeoIndexIpnsToCid(resolution.ipnsName);
    if (cid) {
      return cid;
    }
  }

  return resolution.allowFixedFallback ? getGeoIndexCid() : null;
}

/**
 * Load and parse the derived geo index JSON via the shared IPFS helpers.
 * Throws when no geo index CID/IPNS is configured for the requested county.
 */
export async function fetchGeoIndex(county?: string): Promise<GeoIndex> {
  const now = Date.now();
  const resolution = resolveCountyIpns(county, {
    map: process.env.ORACLE_GEO_INDEX_IPNS_MAP,
    singleIpns: process.env.ORACLE_GEO_INDEX_IPNS,
    defaultCounty: process.env.ORACLE_GEO_INDEX_DEFAULT_COUNTY,
  });
  if (!resolution.served) {
    throw new Error(
      `County '${county ?? ""}' is not served by this deployment's geo index`,
    );
  }

  const cacheKey = resolution.countyKey ?? DEFAULT_CACHE_KEY;
  const cached = geoIndexCache.get(cacheKey);
  if (cached !== undefined && now - cached.fetchedAt < CACHE_TTL_MS) {
    logger.debug({ county: cacheKey }, "Geo index served from cache");
    return cached.index;
  }

  const cid = await resolveGeoIndexCid(county);
  if (!cid) {
    throw new Error(
      "No geo index configured — set ORACLE_GEO_INDEX_CID or ORACLE_GEO_INDEX_IPNS",
    );
  }

  logger.info({ cid, county: cacheKey }, "Fetching derived geo index");

  const raw = await getJsonByCid<unknown>(cid);
  const index = GeoIndexSchema.parse(raw);

  geoIndexCache.set(cacheKey, { index, fetchedAt: now });
  logger.info(
    { county: index.county, entries: index.entries.length },
    "Geo index loaded and cached",
  );

  return index;
}
