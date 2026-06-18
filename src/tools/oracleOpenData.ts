import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";
import { getJsonByCid } from "../lib/ipfs.ts";
import { fetchOracleManifest, getManifestCid } from "../lib/oracleManifest.ts";
import type {
  SlimPropertyEntry,
  ListOraclePropertiesResult,
} from "../types/oracleOpenData.ts";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

export async function listOraclePropertiesHandler(args: {
  county?: string;
  limit?: number;
  offset?: number;
}) {
  try {
    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = args.offset ?? 0;

    const manifest = await fetchOracleManifest();

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
      const manifest = await fetchOracleManifest();

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

export async function getOracleDatasetInfoHandler() {
  try {
    const manifest = await fetchOracleManifest();
    const manifestCid = getManifestCid();

    return createTextResult({
      county: manifest.county,
      propertyCount: manifest.propertyCount,
      exportedAt: manifest.exportedAt ?? manifest.completedAt ?? null,
      schemaVersion: manifest.schemaVersion ?? null,
      totalBytes: manifest.totalBytes ?? null,
      manifestCid,
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
