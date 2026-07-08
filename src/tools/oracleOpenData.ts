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
import {
  isCountyServedByQueryTable,
  runInternalPropertyQuery,
  PROPERTIES_VIEW,
} from "../lib/duckdbQuery.ts";
import { getDatasetCoverageEntries } from "../lib/datasetCoverage.ts";
import type { Json } from "@duckdb/node-api";
import type {
  SlimPropertyEntry,
  ListOraclePropertiesResult,
  ShardRef,
} from "../types/oracleOpenData.ts";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

/** Coerce a DuckDB Json scalar to a finite number, or null. */
function toNumberOrNull(value: Json | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a DuckDB Json scalar to a non-empty string, or null. */
function toStringOrNull(value: Json | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/** Join the situs address parts into a single display string, or null. */
function formatAddress(
  street: Json | undefined,
  city: Json | undefined,
  zip: Json | undefined,
): string | null {
  const parts = [street, city, zip]
    .map((part) => toStringOrNull(part))
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

type PropertyLookupKey =
  | { readonly parcelIdentifier: string }
  | { readonly propertyId: string };

type CidResolution =
  | { readonly cid: string; readonly error?: undefined }
  | { readonly cid?: undefined; readonly error: string };

/**
 * Resolve a property's IPFS CID from the per-county query table. Only the CID
 * lookup moves off the sharded index — the full consolidated record is still
 * fetched from the pinned property file on IPFS by the caller.
 */
async function resolvePropertyCidFromQueryTable(
  county: string | undefined,
  key: PropertyLookupKey,
): Promise<CidResolution> {
  const isParcel = "parcelIdentifier" in key;
  const value = isParcel ? key.parcelIdentifier : key.propertyId;
  const column = isParcel ? "parcel_identifier" : "property_id";
  const label = isParcel
    ? `parcelIdentifier '${value}'`
    : `propertyId '${value}'`;

  const rows = await runInternalPropertyQuery(
    county,
    `SELECT property_cid FROM ${PROPERTIES_VIEW} WHERE ${column} = $1 LIMIT 1`,
    [value],
  );

  if (rows.length === 0) {
    return { error: `Property with ${label} not found in the query table.` };
  }

  const cid = toStringOrNull(rows[0]?.property_cid);
  if (cid === null) {
    return {
      error: `Property with ${label} has no property_cid in the query table.`,
    };
  }
  return { cid };
}

/**
 * Paginated listing served from the per-county query table. Keeps the legacy
 * slim fields (propertyId, parcelIdentifier, cid, county) and adds address,
 * marketValue and ownerName now that they are cheaply available.
 */
async function listOraclePropertiesFromQueryTable(
  county: string | undefined,
  limit: number,
  offset: number,
): Promise<ListOraclePropertiesResult> {
  const countRows = await runInternalPropertyQuery(
    county,
    `SELECT count(*) AS c FROM ${PROPERTIES_VIEW}`,
  );
  const total = toNumberOrNull(countRows[0]?.c) ?? 0;

  const rows = await runInternalPropertyQuery(
    county,
    `SELECT property_id, parcel_identifier, property_cid, county_name,
            address_street, address_city, address_zip, market_value, owner_name
     FROM ${PROPERTIES_VIEW}
     ORDER BY parcel_identifier
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  const properties: SlimPropertyEntry[] = rows.map((row) => ({
    propertyId: toStringOrNull(row.property_id) ?? "",
    parcelIdentifier: toStringOrNull(row.parcel_identifier) ?? "",
    cid: toStringOrNull(row.property_cid),
    county: toStringOrNull(row.county_name) ?? county ?? "",
    fileSizeBytes: null,
    address: formatAddress(
      row.address_street,
      row.address_city,
      row.address_zip,
    ),
    marketValue: toNumberOrNull(row.market_value),
    ownerName: toStringOrNull(row.owner_name),
  }));

  return { total, offset, limit, properties };
}

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

    // Query-table PRIMARY path: paginate straight from the per-county Parquet.
    if (isCountyServedByQueryTable(args.county)) {
      const result = await listOraclePropertiesFromQueryTable(
        args.county,
        limit,
        offset,
      );
      return createTextResult(result);
    }

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
    } else if (isCountyServedByQueryTable(args.county)) {
      // Query-table PRIMARY path: resolve the CID via SQL, then fetch the full
      // consolidated record from IPFS by CID (unchanged below).
      const resolution = await resolvePropertyCidFromQueryTable(
        args.county,
        hasParcelIdentifier
          ? { parcelIdentifier: args.parcelIdentifier! }
          : { propertyId: args.propertyId! },
      );
      if (resolution.error !== undefined) {
        return createTextResult({ error: resolution.error });
      }
      resolvedCid = resolution.cid;
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

/**
 * Build the base (single-dataset) portion of the dataset-info response from the
 * query-table / sharded-index / flat-manifest paths. Coverage datasets are
 * merged on top by the handler. Returns null when the county is not served by
 * any property dataset (it may still have per-source coverage).
 */
async function buildBaseDatasetInfo(
  county: string | undefined,
): Promise<Record<string, unknown> | null> {
  // Query-table PRIMARY path: report county + live row count from the Parquet
  // so the tool no longer returns the stale pilot manifest count.
  if (isCountyServedByQueryTable(county)) {
    const rows = await runInternalPropertyQuery(
      county,
      `SELECT count(*) AS c, any_value(county_name) AS county,
              any_value(state_code) AS state FROM ${PROPERTIES_VIEW}`,
    );
    const row = rows[0] ?? {};
    return {
      county: toStringOrNull(row.county) ?? county ?? null,
      stateCode: toStringOrNull(row.state),
      propertyCount: toNumberOrNull(row.c) ?? 0,
      source: "query-table",
      exportedAt: null,
      ipnsName: getOpenDataIpnsName(county) ?? null,
    };
  }

  // Try sharded index first — resolved from the requested county's IPNS.
  const index = await fetchOracleIndex(county);

  if (index !== null) {
    // Legacy single-IPNS mode serves one dataset for any county; guard
    // against reporting a different dataset's metadata.
    if (county && index.county.toLowerCase() !== county.toLowerCase()) {
      return null;
    }

    return {
      county: index.county,
      propertyCount: index.propertyCount,
      exportedAt: index.exportedAt,
      completedAt: index.completedAt,
      shardSize: index.shardSize,
      shardCount: index.shards.length,
      totalBytes: index.totalBytes,
      indexCid: getIndexCid() ?? null,
      ipnsName: getOpenDataIpnsName(county) ?? null,
    };
  }

  // Fallback: flat manifest. A null manifest means the requested county is
  // not served by this deployment.
  const manifest = await fetchOracleManifest(county);

  if (manifest === null) {
    return null;
  }

  // Legacy single-IPNS mode serves one manifest for any county; guard
  // against reporting a different dataset's metadata.
  if (county && manifest.county.toLowerCase() !== county.toLowerCase()) {
    return null;
  }

  return {
    county: manifest.county,
    propertyCount: manifest.propertyCount,
    exportedAt: manifest.exportedAt ?? manifest.completedAt ?? null,
    schemaVersion: manifest.schemaVersion ?? null,
    totalBytes: manifest.totalBytes ?? null,
    manifestCid: getManifestCid(),
    indexCid: getIndexCid() ?? null,
    ipnsName: getOpenDataIpnsName(county) ?? null,
  };
}

export async function getOracleDatasetInfoHandler(
  args: { county?: string } = {},
) {
  try {
    // Per-source coverage (appraisal, permits, sunbiz, bbb) is additive and
    // resolved independently of the property dataset, so a permits-only county
    // still reports coverage even without an appraisal query table.
    const [base, coverage] = await Promise.all([
      buildBaseDatasetInfo(args.county),
      getDatasetCoverageEntries(args.county),
    ]);

    // County served by neither a property dataset nor coverage → not served.
    if (base === null && (coverage === null || coverage.length === 0)) {
      return countyNotServedResult(args.county);
    }

    const result: Record<string, unknown> = base ?? {
      county: args.county ?? null,
      propertyCount: 0,
    };

    if (coverage !== null && coverage.length > 0) {
      result.datasets = coverage;
    }

    return createTextResult(result);
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
