import { z } from "zod";
import { getJsonByCid } from "./ipfs.ts";
import { logger } from "../logger.ts";

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

interface GeoIndexCacheEntry {
  index: GeoIndex;
  fetchedAt: number;
}

let geoIndexCache: GeoIndexCacheEntry | null = null;

/**
 * Resolve the geo index CID from ORACLE_GEO_INDEX_CID. Returns null when unset.
 * Intentionally does NOT fall back to any ORACLE_OPEN_DATA_* var.
 */
export function getGeoIndexCid(): string | null {
  return process.env.ORACLE_GEO_INDEX_CID ?? null;
}

export function clearGeoIndexCache(): void {
  geoIndexCache = null;
}

/**
 * Resolve the geo index IPNS name (ORACLE_GEO_INDEX_IPNS) to its current CID via
 * public IPFS gateways, reading the resolved root from the `x-ipfs-roots`
 * header. Mirrors the open-data manifest resolver but on the geo-specific var.
 */
export async function resolveGeoIndexIpnsToCid(): Promise<string | null> {
  const ipnsName = process.env.ORACLE_GEO_INDEX_IPNS;
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
 * Resolve the CID to read the geo index from: IPNS-resolved CID wins when
 * ORACLE_GEO_INDEX_IPNS is set, otherwise the fixed ORACLE_GEO_INDEX_CID.
 */
async function resolveGeoIndexCid(): Promise<string | null> {
  const ipnsCid = await resolveGeoIndexIpnsToCid();
  if (ipnsCid) {
    return ipnsCid;
  }
  return getGeoIndexCid();
}

/**
 * Load and parse the derived geo index JSON via the shared IPFS helpers.
 * Throws when no geo index CID/IPNS is configured.
 */
export async function fetchGeoIndex(): Promise<GeoIndex> {
  const now = Date.now();

  if (geoIndexCache !== null && now - geoIndexCache.fetchedAt < CACHE_TTL_MS) {
    logger.debug("Geo index served from cache");
    return geoIndexCache.index;
  }

  const cid = await resolveGeoIndexCid();
  if (!cid) {
    throw new Error(
      "No geo index configured — set ORACLE_GEO_INDEX_CID or ORACLE_GEO_INDEX_IPNS",
    );
  }

  logger.info({ cid }, "Fetching derived geo index");

  const raw = await getJsonByCid<unknown>(cid);
  const index = GeoIndexSchema.parse(raw);

  geoIndexCache = { index, fetchedAt: now };
  logger.info(
    { county: index.county, entries: index.entries.length },
    "Geo index loaded and cached",
  );

  return index;
}
