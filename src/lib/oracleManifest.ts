import { getJsonByCid } from "./ipfs.ts";
import { logger } from "../logger.ts";
import {
  resolveCountyIpns,
  type CountyIpnsResolution,
} from "./countyIpnsRegistry.ts";
import {
  OracleManifestSchema,
  OracleIndexSchema,
  type OracleManifest,
  type OracleIndex,
} from "../types/oracleOpenData.ts";

const DEFAULT_MANIFEST_CID = "QmQ6pdjzm4w7ddEjKDekqukqfdBbvDhgphVXqdTsssqK4d";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Cache key used when no county (and no default county) is in play.
const DEFAULT_CACHE_KEY = "__default__";

interface ManifestCacheEntry {
  manifest: OracleManifest;
  fetchedAt: number;
}

// Per-county caches: one MCP deployment may serve several counties, each from
// its own IPNS, so the manifest/index are cached keyed by resolved county.
const manifestCache = new Map<string, ManifestCacheEntry>();

const INDEX_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

type IndexCacheEntry = { index: OracleIndex; fetchedAt: number };
const indexCache = new Map<string, IndexCacheEntry>();

export function getManifestCid(): string {
  return process.env.ORACLE_OPEN_DATA_MANIFEST_CID ?? DEFAULT_MANIFEST_CID;
}

export function clearManifestCache(): void {
  manifestCache.clear();
}

/**
 * Resolve which county→IPNS configuration applies to a request, reading the
 * open-data registry env vars. Exposed so tools can report the resolved IPNS
 * name and short-circuit unknown counties.
 */
export function resolveOpenDataCounty(county?: string): CountyIpnsResolution {
  return resolveCountyIpns(county, {
    map: process.env.ORACLE_OPEN_DATA_IPNS_MAP,
    singleIpns: process.env.ORACLE_OPEN_DATA_IPNS,
    defaultCounty: process.env.ORACLE_OPEN_DATA_DEFAULT_COUNTY,
  });
}

/** The IPNS name configured for a county, or null. Used for reporting. */
export function getOpenDataIpnsName(county?: string): string | null {
  return resolveOpenDataCounty(county).ipnsName;
}

/**
 * Resolve the CID the manifest read path should use for the given county. The
 * county's IPNS (from the registry, or the legacy single IPNS) is resolved to a
 * CID; a fixed env/default CID is only used as a fallback for the legacy/default
 * county. Returns null when the county is not served by this deployment.
 */
export async function resolveManifestCid(
  county?: string,
): Promise<string | null> {
  const resolution = resolveOpenDataCounty(county);
  if (!resolution.served) {
    return null;
  }

  if (resolution.ipnsName) {
    const cid = await resolveIpnsToCid(resolution.ipnsName);
    if (cid) {
      return cid;
    }
  }

  return resolution.allowFixedFallback ? getManifestCid() : null;
}

/**
 * Load the flat open-data manifest for a county. Returns null when the county is
 * not served by this deployment (no IPNS configured for it).
 */
export async function fetchOracleManifest(
  county?: string,
): Promise<OracleManifest | null> {
  const now = Date.now();
  const resolution = resolveOpenDataCounty(county);
  if (!resolution.served) {
    return null;
  }

  const cacheKey = resolution.countyKey ?? DEFAULT_CACHE_KEY;
  const cached = manifestCache.get(cacheKey);
  if (cached !== undefined && now - cached.fetchedAt < CACHE_TTL_MS) {
    logger.debug({ county: cacheKey }, "Oracle manifest served from cache");
    return cached.manifest;
  }

  const cid = await resolveManifestCid(county);
  if (!cid) {
    return null;
  }
  logger.info({ cid, county: cacheKey }, "Fetching Oracle open-data manifest");

  const raw = await getJsonByCid<unknown>(cid);
  const manifest = OracleManifestSchema.parse(raw);

  manifestCache.set(cacheKey, { manifest, fetchedAt: now });
  logger.info(
    { propertyCount: manifest.propertyCount, county: manifest.county },
    "Oracle manifest loaded and cached",
  );

  return manifest;
}

export function getIndexCid(): string | null {
  return process.env.ORACLE_OPEN_DATA_INDEX_CID ?? null;
}

export function clearIndexCache(): void {
  indexCache.clear();
}

/**
 * Resolve an IPNS name (k51…) to its current CID using public IPFS gateways.
 *
 * The Kubo RPC `/api/v0/name/resolve` endpoint is NO LONGER exposed by the
 * public gateways (ipfs.io / gateway.ipfs.io return "Kubo RPC is not here").
 * Modern path-and-subdomain gateways instead expose the resolved root CID in
 * the `x-ipfs-roots` response header. We issue a HEAD request and read that
 * header — works for both flat-manifest and sharded-index targets.
 */
export async function resolveIpnsToCid(
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
    try {
      const response = await fetch(url, { method: "HEAD", redirect: "follow" });
      if (!response.ok) {
        logger.warn(
          { url, status: response.status },
          "IPNS resolve endpoint returned non-2xx",
        );
        continue;
      }
      // `x-ipfs-roots` is the resolved root CID(s); take the last one (the
      // leaf the IPNS path points at). `x-ipfs-path` carries /ipns/<name>.
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
        "IPNS resolution failed for endpoint",
      );
    }
  }

  logger.warn({ ipnsName }, "All IPNS resolution endpoints failed");
  return null;
}

export async function fetchOracleIndex(
  county?: string,
): Promise<OracleIndex | null> {
  const now = Date.now();
  const resolution = resolveOpenDataCounty(county);
  if (!resolution.served) {
    return null;
  }

  const cacheKey = resolution.countyKey ?? DEFAULT_CACHE_KEY;
  const cached = indexCache.get(cacheKey);
  if (cached !== undefined && now - cached.fetchedAt < INDEX_CACHE_TTL_MS) {
    logger.debug({ county: cacheKey }, "Oracle index served from cache");
    return cached.index;
  }

  try {
    // Resolve this county's IPNS to a CID. The fixed env-var CID is only used
    // as a fallback for the legacy/default county (never cross-county).
    let cid = resolution.ipnsName
      ? await resolveIpnsToCid(resolution.ipnsName)
      : null;

    if (!cid && resolution.allowFixedFallback) {
      cid = getIndexCid();
    }

    if (!cid) {
      return null;
    }

    logger.info({ cid, county: cacheKey }, "Fetching Oracle sharded index");

    const raw = await getJsonByCid<unknown>(cid);

    // Auto-detect: the IPNS name (or fixed CID) may point at a SHARDED index
    // OR a FLAT manifest (the old 4,664 format). Try the index schema first;
    // if the content is actually a flat manifest, return null so the caller
    // falls back to fetchOracleManifest, which reads the same IPNS-resolved CID.
    const parsed = OracleIndexSchema.safeParse(raw);
    if (!parsed.success) {
      logger.info(
        { cid },
        "IPNS/CID content is not a sharded index — falling back to flat manifest read path",
      );
      return null;
    }
    const index = parsed.data;

    indexCache.set(cacheKey, { index, fetchedAt: now });
    logger.info(
      {
        propertyCount: index.propertyCount,
        county: index.county,
        shards: index.shards.length,
      },
      "Oracle index loaded and cached",
    );

    return index;
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to fetch Oracle index — falling back to manifest",
    );
    return null;
  }
}
