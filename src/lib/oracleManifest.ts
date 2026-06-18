import { getJsonByCid } from "./ipfs.ts";
import { logger } from "../logger.ts";
import {
  OracleManifestSchema,
  type OracleManifest,
} from "../types/oracleOpenData.ts";

const DEFAULT_MANIFEST_CID = "QmQ6pdjzm4w7ddEjKDekqukqfdBbvDhgphVXqdTsssqK4d";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface ManifestCacheEntry {
  manifest: OracleManifest;
  fetchedAt: number;
}

let manifestCache: ManifestCacheEntry | null = null;

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
