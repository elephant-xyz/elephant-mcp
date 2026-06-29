import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";
import { getJsonByCid, fetchShardByCid } from "../lib/ipfs.ts";
import {
  fetchOracleManifest,
  getManifestCid,
  fetchOracleIndex,
  getIndexCid,
  getOpenDataIpnsName,
} from "../lib/oracleManifest.ts";
import type {
  SlimPropertyEntry,
  ListOraclePropertiesResult,
  ShardRef,
} from "../types/oracleOpenData.ts";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

/**
 * Dataset-info result for a county this deployment does not serve (unknown
 * county, or a county that doesn't match the single legacy dataset).
 */
function countyNotServedResult(county?: string) {
  return createTextResult({
    error: county
      ? `County '${county}' is not served by this deployment.`
      : "No oracle open-data dataset is available.",
    county: county ?? null,
    propertyCount: 0,
  });
}

/**
 * Binary search: find the shard whose [fromParcel, toParcel] range contains
 * the given parcelIdentifier. Parcel IDs are compared lexicographically.
 * Returns null if no shard covers the parcel.
 */
function findShardForParcel(
  shards: ShardRef[],
  parcelIdentifier: string,
): ShardRef | null {
  let lo = 0;
  let hi = shards.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const shard = shards[mid];
    if (parcelIdentifier < shard.fromParcel) {
      hi = mid - 1;
    } else if (parcelIdentifier > shard.toParcel) {
      lo = mid + 1;
    } else {
      return shard;
    }
  }
  return null;
}

/**
 * Determine which shards overlap the requested page [offset, offset+limit).
 * Returns an array of { shard, sliceStart, sliceEnd } where sliceStart/End
 * are indices into that shard's entries array.
 *
 * Shards are walked in order; cumulative offset is tracked to find the
 * correct slice within each overlapping shard.
 */
function findShardRanges(
  shards: ShardRef[],
  offset: number,
  limit: number,
): Array<{ shard: ShardRef; sliceStart: number; sliceEnd: number }> {
  const result: Array<{
    shard: ShardRef;
    sliceStart: number;
    sliceEnd: number;
  }> = [];

  let cumulative = 0;
  let remaining = limit;

  for (const shard of shards) {
    if (remaining <= 0) break;

    const shardStart = cumulative;
    const shardEnd = cumulative + shard.count;

    // Does this shard overlap [offset, offset+limit)?
    if (shardEnd > offset && shardStart < offset + limit) {
      const sliceStart = Math.max(0, offset - shardStart);
      const sliceEnd = Math.min(shard.count, offset + limit - shardStart);
      result.push({ shard, sliceStart, sliceEnd });
      remaining -= sliceEnd - sliceStart;
    }

    cumulative = shardEnd;
  }

  return result;
}

export async function listOraclePropertiesHandler(args: {
  county?: string;
  limit?: number;
  offset?: number;
}) {
  try {
    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = args.offset ?? 0;

    // Try sharded index first — resolved from the requested county's IPNS.
    const index = await fetchOracleIndex(args.county);

    if (index !== null) {
      // County filter: the index covers exactly one county
      const countyMatches =
        !args.county ||
        index.county.toLowerCase() === args.county.toLowerCase();

      const total = countyMatches ? index.propertyCount : 0;

      if (!countyMatches || total === 0) {
        const result: ListOraclePropertiesResult = {
          total,
          offset,
          limit,
          properties: [],
        };
        return createTextResult(result);
      }

      const ranges = findShardRanges(index.shards, offset, limit);

      const properties: SlimPropertyEntry[] = [];

      for (const { shard, sliceStart, sliceEnd } of ranges) {
        if (!shard.shardCid) {
          logger.warn(
            { shardIndex: shard.shardIndex },
            "Shard has null CID — skipping",
          );
          continue;
        }
        const shardFile = await fetchShardByCid(shard.shardCid);
        const entries = shardFile.entries.slice(sliceStart, sliceEnd);
        for (const e of entries) {
          properties.push({
            propertyId: e.propertyId,
            parcelIdentifier: e.parcelIdentifier,
            cid: e.cid,
            county: index.county,
            fileSizeBytes: e.fileSizeBytes,
          });
        }
      }

      const result: ListOraclePropertiesResult = {
        total,
        offset,
        limit,
        properties,
      };
      return createTextResult(result);
    }

    // Fallback: flat manifest. A null manifest means the requested county is
    // not served by this deployment → empty result.
    const manifest = await fetchOracleManifest(args.county);

    if (manifest === null) {
      const result: ListOraclePropertiesResult = {
        total: 0,
        offset,
        limit,
        properties: [],
      };
      return createTextResult(result);
    }

    const countyMatches =
      !args.county ||
      manifest.county.toLowerCase() === args.county.toLowerCase();

    const filtered = countyMatches ? manifest.entries : [];
    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);

    const properties: SlimPropertyEntry[] = page.map((e) => ({
      propertyId: e.propertyId,
      parcelIdentifier: e.parcelIdentifier,
      cid: e.cid,
      county: manifest.county,
      fileSizeBytes: e.fileSizeBytes,
    }));

    const result: ListOraclePropertiesResult = {
      total,
      offset,
      limit,
      properties,
    };

    return createTextResult(result);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        args,
      },
      "listOracleProperties failed",
    );
    return createTextResult({
      error: "Failed to list oracle properties",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getOraclePropertyHandler(args: {
  parcelIdentifier?: string;
  propertyId?: string;
  cid?: string;
  county?: string;
}) {
  const hasCid = typeof args.cid === "string" && args.cid.length > 0;
  const hasParcelIdentifier =
    typeof args.parcelIdentifier === "string" &&
    args.parcelIdentifier.length > 0;
  const hasPropertyId =
    typeof args.propertyId === "string" && args.propertyId.length > 0;

  const providedCount =
    (hasCid ? 1 : 0) + (hasParcelIdentifier ? 1 : 0) + (hasPropertyId ? 1 : 0);

  if (providedCount > 1) {
    return createTextResult({
      error:
        "Provide exactly one of parcelIdentifier, propertyId, or cid — not multiple.",
    });
  }

  if (providedCount === 0) {
    return createTextResult({
      error: "Provide exactly one of parcelIdentifier, propertyId, or cid.",
    });
  }

  try {
    let resolvedCid: string;

    if (hasCid) {
      resolvedCid = args.cid!;
    } else {
      // Try sharded index first — resolved from the requested county's IPNS.
      const index = await fetchOracleIndex(args.county);

      if (index !== null) {
        // In legacy single-IPNS mode the index is served for any requested
        // county; guard against returning a parcel from a different dataset.
        if (
          args.county &&
          index.county.toLowerCase() !== args.county.toLowerCase()
        ) {
          const lookupKey = hasParcelIdentifier
            ? `parcelIdentifier '${args.parcelIdentifier}'`
            : `propertyId '${args.propertyId}'`;
          return createTextResult({
            error: `Property with ${lookupKey} not found in county '${args.county}'.`,
          });
        }

        if (hasParcelIdentifier) {
          // Fast path: binary search shards by parcel range
          const shard = findShardForParcel(
            index.shards,
            args.parcelIdentifier!,
          );

          if (!shard || !shard.shardCid) {
            return createTextResult({
              error: `Property with parcelIdentifier '${args.parcelIdentifier}' not found in the oracle index.`,
            });
          }

          const shardFile = await fetchShardByCid(shard.shardCid);
          const entry = shardFile.entries.find(
            (e) => e.parcelIdentifier === args.parcelIdentifier,
          );

          if (!entry || !entry.cid) {
            return createTextResult({
              error: `Property with parcelIdentifier '${args.parcelIdentifier}' not found in the oracle index.`,
            });
          }

          resolvedCid = entry.cid;
        } else {
          // propertyId lookup: linear scan across shards (parcelIdentifier is the fast path)
          // Note: this is O(shards) fetch operations; parcelIdentifier is preferred for performance.
          let foundCid: string | null = null;

          for (const shardRef of index.shards) {
            if (!shardRef.shardCid) continue;

            const shardFile = await fetchShardByCid(shardRef.shardCid);
            const entry = shardFile.entries.find(
              (e) => e.propertyId === args.propertyId,
            );

            if (entry?.cid) {
              foundCid = entry.cid;
              break;
            }
          }

          if (!foundCid) {
            return createTextResult({
              error: `Property with propertyId '${args.propertyId}' not found in the oracle index.`,
            });
          }

          resolvedCid = foundCid;
        }
      } else {
        // Fallback: flat manifest. A null manifest means the requested county
        // is not served by this deployment.
        const manifest = await fetchOracleManifest(args.county);

        if (manifest === null) {
          return createTextResult({
            error: args.county
              ? `County '${args.county}' is not served by this deployment.`
              : "No oracle open-data manifest is available.",
          });
        }

        // Legacy single-IPNS mode serves one manifest for any county; guard
        // against returning a parcel from a different dataset.
        if (
          args.county &&
          manifest.county.toLowerCase() !== args.county.toLowerCase()
        ) {
          const lookupKey = hasParcelIdentifier
            ? `parcelIdentifier '${args.parcelIdentifier}'`
            : `propertyId '${args.propertyId}'`;
          return createTextResult({
            error: `Property with ${lookupKey} not found in county '${args.county}'.`,
          });
        }

        const entry = hasParcelIdentifier
          ? manifest.entries.find(
              (e) => e.parcelIdentifier === args.parcelIdentifier,
            )
          : manifest.entries.find((e) => e.propertyId === args.propertyId);

        if (!entry) {
          const lookupKey = hasParcelIdentifier
            ? `parcelIdentifier '${args.parcelIdentifier}'`
            : `propertyId '${args.propertyId}'`;
          return createTextResult({
            error: `Property with ${lookupKey} not found in the oracle manifest.`,
          });
        }

        resolvedCid = entry.cid;
      }
    }

    const propertyData = await getJsonByCid<unknown>(resolvedCid);
    return createTextResult(propertyData);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        args,
      },
      "getOracleProperty failed",
    );
    return createTextResult({
      error: "Failed to fetch oracle property",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getOracleDatasetInfoHandler(
  args: { county?: string } = {},
) {
  try {
    // Try sharded index first — resolved from the requested county's IPNS.
    const index = await fetchOracleIndex(args.county);

    if (index !== null) {
      // Legacy single-IPNS mode serves one dataset for any county; guard
      // against reporting a different dataset's metadata.
      if (
        args.county &&
        index.county.toLowerCase() !== args.county.toLowerCase()
      ) {
        return countyNotServedResult(args.county);
      }

      return createTextResult({
        county: index.county,
        propertyCount: index.propertyCount,
        exportedAt: index.exportedAt,
        completedAt: index.completedAt,
        shardSize: index.shardSize,
        shardCount: index.shards.length,
        totalBytes: index.totalBytes,
        indexCid: getIndexCid() ?? null,
        ipnsName: getOpenDataIpnsName(args.county) ?? null,
      });
    }

    // Fallback: flat manifest. A null manifest means the requested county is
    // not served by this deployment.
    const manifest = await fetchOracleManifest(args.county);

    if (manifest === null) {
      return countyNotServedResult(args.county);
    }

    // Legacy single-IPNS mode serves one manifest for any county; guard
    // against reporting a different dataset's metadata.
    if (
      args.county &&
      manifest.county.toLowerCase() !== args.county.toLowerCase()
    ) {
      return countyNotServedResult(args.county);
    }

    const manifestCid = getManifestCid();

    return createTextResult({
      county: manifest.county,
      propertyCount: manifest.propertyCount,
      exportedAt: manifest.exportedAt ?? manifest.completedAt ?? null,
      schemaVersion: manifest.schemaVersion ?? null,
      totalBytes: manifest.totalBytes ?? null,
      manifestCid,
      indexCid: getIndexCid() ?? null,
      ipnsName: getOpenDataIpnsName(args.county) ?? null,
    });
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      "getOracleDatasetInfo failed",
    );
    return createTextResult({
      error: "Failed to fetch oracle dataset info",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
