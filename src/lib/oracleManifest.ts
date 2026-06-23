import { getJsonByCid } from "./ipfs.ts";
import { logger } from "../logger.ts";
import {
  OracleManifestSchema,
  OracleIndexSchema,
  type OracleManifest,
  type OracleIndex,
} from "../types/oracleOpenData.ts";

const DEFAULT_MANIFEST_CID = "QmQ6pdjzm4w7ddEjKDekqukqfdBbvDhgphVXqdTsssqK4d";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface ManifestCacheEntry {
  manifest: OracleManifest;
  fetchedAt: number;
}

let manifestCache: ManifestCacheEntry | null = null;

const INDEX_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

type IndexCacheEntry = { index: OracleIndex; fetchedAt: number };
let indexCache: IndexCacheEntry | null = null;

export function getManifestCid(): string {
  return process.env.ORACLE_OPEN_DATA_MANIFEST_CID ?? DEFAULT_MANIFEST_CID;
}

export function clearManifestCache(): void {
  manifestCache = null;
}

/**
 * Resolve the CID the manifest read path should use. When ORACLE_OPEN_DATA_IPNS
 * is set, the IPNS-resolved CID wins so that the manifest is served via the IPNS
 * name (which may point at either a sharded index or a flat manifest — see
 * fetchOracleIndex for the auto-detect). Falls back to the fixed env/default CID.
 */
async function resolveManifestCid(): Promise<string> {
  const ipnsCid = await resolveIpnsToCid();
  if (ipnsCid) {
    return ipnsCid;
  }
  return getManifestCid();
}

export async function fetchOracleManifest(): Promise<OracleManifest> {
  const now = Date.now();

  if (manifestCache !== null && now - manifestCache.fetchedAt < CACHE_TTL_MS) {
    logger.debug("Oracle manifest served from cache");
    return manifestCache.manifest;
  }

  const cid = await resolveManifestCid();
  logger.info({ cid }, "Fetching Oracle open-data manifest");

  const raw = await getJsonByCid<unknown>(cid);
  const manifest = OracleManifestSchema.parse(raw);

  manifestCache = { manifest, fetchedAt: now };
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
  indexCache = null;
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
export async function resolveIpnsToCid(): Promise<string | null> {
  const ipnsName = process.env.ORACLE_OPEN_DATA_IPNS;
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
        const cid = roots.split(",").map((s) => s.trim()).filter(Boolean).pop();
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

export async function fetchOracleIndex(): Promise<OracleIndex | null> {
  const now = Date.now();

  if (indexCache !== null && now - indexCache.fetchedAt < INDEX_CACHE_TTL_MS) {
    logger.debug("Oracle index served from cache");
    return indexCache.index;
  }

  try {
    // Try IPNS resolution first
    let cid = await resolveIpnsToCid();

    // Fall back to fixed env-var CID
    if (!cid) {
      cid = getIndexCid();
    }

    if (!cid) {
      return null;
    }

    logger.info({ cid }, "Fetching Oracle sharded index");

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

    indexCache = { index, fetchedAt: now };
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
