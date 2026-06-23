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

export async function fetchOracleManifest(): Promise<OracleManifest> {
  const now = Date.now();

  if (manifestCache !== null && now - manifestCache.fetchedAt < CACHE_TTL_MS) {
    logger.debug("Oracle manifest served from cache");
    return manifestCache.manifest;
  }

  const cid = getManifestCid();
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

export async function resolveIpnsToIndexCid(): Promise<string | null> {
  const ipnsName = process.env.ORACLE_OPEN_DATA_IPNS;
  if (!ipnsName) {
    return null;
  }

  const endpoints = [
    `https://gateway.ipfs.io/api/v0/name/resolve?arg=${encodeURIComponent(ipnsName)}`,
    `https://ipfs.io/api/v0/name/resolve?arg=${encodeURIComponent(ipnsName)}`,
  ];

  for (const url of endpoints) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) {
        logger.warn(
          { url, status: response.status },
          "IPNS resolve endpoint returned non-2xx",
        );
        continue;
      }
      const data = (await response.json()) as { Path?: string };
      if (typeof data.Path === "string") {
        // Path is like "/ipfs/QmXxx..." — extract the CID
        const match = /^\/ipfs\/(.+)$/.exec(data.Path);
        if (match) {
          return match[1];
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
    let cid = await resolveIpnsToIndexCid();

    // Fall back to fixed env-var CID
    if (!cid) {
      cid = getIndexCid();
    }

    if (!cid) {
      return null;
    }

    logger.info({ cid }, "Fetching Oracle sharded index");

    const raw = await getJsonByCid<unknown>(cid);
    const index = OracleIndexSchema.parse(raw);

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
