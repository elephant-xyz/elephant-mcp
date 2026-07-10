import { readFile } from "node:fs/promises";

import { logger } from "../logger.ts";
import { normalizeCountyKey } from "./countyIpnsRegistry.ts";
import {
  OracleDatasetCoverageSnapshotSchema,
  type OracleDatasetCoverageRow,
  type OracleDatasetCoverageSnapshot,
  type OracleDatasetInfoCoverageEntry,
} from "../types/oracleOpenData.ts";

/**
 * Per-source dataset coverage reader.
 *
 * The query-db publish loop writes a `dataset-coverage.json` snapshot per
 * county (see `oracle_dataset_coverage`). This deployment maps each county to
 * that snapshot's location so `getOracleDatasetInfo` can report count/%/date
 * range per source without a Postgres dependency — mirroring the
 * PROPERTY_QUERY_TABLE_MAP pattern used for the Parquet query table:
 *
 *   Built-in defaults   – public Filebase/IPNS snapshots for published counties
 *   DATASET_COVERAGE_MAP  – JSON map {"lee":"<location>", ...}
 *   DATASET_COVERAGE      – legacy single-county location (fallback)
 *   DATASET_COVERAGE_DEFAULT_COUNTY – county the single location serves
 *
 * A <location> is EITHER a local filesystem path OR an http(s) URL (e.g. an
 * IPNS gateway URL like https://ipfs.filebase.io/ipns/<name>/dataset-coverage.json).
 */

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SNAPSHOT_TIMEOUT_MS = 12_000;
const DEFAULT_CACHE_KEY = "__default__";

export const DEFAULT_DATASET_COVERAGE_MAP: Readonly<Record<string, string>> = {
  lee: "https://k51qzi5uqu5dimw0elyh4agbtqe7v2fzp0jcd7b1bcu8kxs0hml7yu1no0z0vd.ipns.dweb.link/",
  "miami-dade":
    "https://k51qzi5uqu5djj45hvhz6z2dnsdg6pkgucds99t0f78d5gmwu19bfv8o9tygno.ipns.dweb.link/",
  orange:
    "https://k51qzi5uqu5dj8n2f8nowh8kts53rvpr62zfj0mz9izc11rfzv56q7m4161lg7.ipns.dweb.link/",
  "palm-beach":
    "https://k51qzi5uqu5djwga4mcd8nx1gbwy4o9rks3gkoe1u5py5wi9tieea7h44nh4g2.ipns.dweb.link/",
};

interface CoverageCacheEntry {
  readonly snapshot: OracleDatasetCoverageSnapshot | null;
  readonly fetchedAt: number;
}

const coverageCache = new Map<string, CoverageCacheEntry>();

/** Reset the coverage snapshot cache. Intended for tests. */
export function clearDatasetCoverageCache(): void {
  coverageCache.clear();
}

export interface CoverageResolution {
  readonly served: boolean;
  readonly location: string | null;
  readonly countyKey: string | null;
}

/**
 * Parse the DATASET_COVERAGE_MAP env var (a JSON object of
 * county → snapshot location). Returns an empty map when unset, blank, or
 * malformed — the failure is logged so a bad config is visible without
 * crashing the server. Keys are normalized; blank/non-string values skipped.
 *
 * @param raw - Raw env value.
 * @returns Normalized county → location map.
 */
export function parseCoverageMap(
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
      "Failed to parse DATASET_COVERAGE_MAP JSON — ignoring",
    );
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    logger.warn("DATASET_COVERAGE_MAP is not a JSON object — ignoring");
    return {};
  }

  const map: Record<string, string> = {};
  for (const [county, location] of Object.entries(parsed)) {
    if (typeof location !== "string" || location.trim() === "") {
      logger.warn(
        { county },
        "Skipping DATASET_COVERAGE_MAP entry with a non-string/blank location",
      );
      continue;
    }
    map[normalizeCountyKey(county)] = location.trim();
  }

  return map;
}

/**
 * Resolve the coverage snapshot location for a county, mirroring
 * {@link import("./duckdbQuery.ts").resolveQueryTableLocation}.
 *
 * @param county - Requested county (any casing / slug), or undefined.
 * @returns Whether a snapshot is served, its location, and the normalized key.
 */
export function resolveCoverageLocation(
  county: string | undefined,
): CoverageResolution {
  const map = {
    ...DEFAULT_DATASET_COVERAGE_MAP,
    ...parseCoverageMap(process.env.DATASET_COVERAGE_MAP),
  };
  const single = process.env.DATASET_COVERAGE?.trim() || null;
  const defaultCountyKey = process.env.DATASET_COVERAGE_DEFAULT_COUNTY
    ? normalizeCountyKey(process.env.DATASET_COVERAGE_DEFAULT_COUNTY)
    : null;
  const requestedKey = county ? normalizeCountyKey(county) : defaultCountyKey;

  if (Object.keys(map).length === 0 && single !== null) {
    return {
      served: true,
      location: single,
      countyKey: requestedKey,
    };
  }

  if (requestedKey === null) {
    return { served: single !== null, location: single, countyKey: null };
  }

  const mapped = map[requestedKey];
  if (mapped !== undefined) {
    return { served: true, location: mapped, countyKey: requestedKey };
  }

  if (single !== null && (defaultCountyKey === null || requestedKey === defaultCountyKey)) {
    return {
      served: true,
      location: single,
      countyKey: requestedKey,
    };
  }

  return { served: false, location: null, countyKey: requestedKey };
}

function isHttpLocation(location: string): boolean {
  return /^https?:\/\//i.test(location);
}

/**
 * Read the raw snapshot JSON from a location (http(s) URL or local path).
 *
 * @param location - Snapshot location.
 * @returns Parsed JSON (unknown), or null on any read/parse failure.
 */
async function readSnapshotJson(location: string): Promise<unknown> {
  if (isHttpLocation(location)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(location, {
        redirect: "follow",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      logger.warn(
        { location, status: response.status },
        "Coverage snapshot fetch returned non-2xx",
      );
      return null;
    }
    return (await response.json()) as unknown;
  }
  const text = await readFile(location, "utf8");
  return JSON.parse(text) as unknown;
}

/**
 * Fetch and validate the coverage snapshot for a county. Cached with a short
 * TTL. Returns null when the county has no configured snapshot, or the read /
 * validation fails (coverage is additive — a failure never breaks dataset-info).
 *
 * @param county - Requested county.
 * @returns The validated snapshot, or null.
 */
export async function fetchDatasetCoverage(
  county: string | undefined,
): Promise<OracleDatasetCoverageSnapshot | null> {
  const resolution = resolveCoverageLocation(county);
  if (!resolution.served || resolution.location === null) {
    return null;
  }

  const now = Date.now();
  const cacheKey = resolution.countyKey ?? DEFAULT_CACHE_KEY;
  const cached = coverageCache.get(cacheKey);
  if (cached !== undefined && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.snapshot;
  }

  let snapshot: OracleDatasetCoverageSnapshot | null = null;
  try {
    const raw = await readSnapshotJson(resolution.location);
    if (raw !== null) {
      const parsed = OracleDatasetCoverageSnapshotSchema.safeParse(raw);
      if (parsed.success) {
        // Guard against a stale/misconfigured location serving another
        // county's snapshot — mirroring the county-mismatch rejection the
        // property metadata paths already apply.
        const snapshotCountyKey = normalizeCountyKey(parsed.data.county);
        if (
          resolution.countyKey !== null &&
          snapshotCountyKey !== resolution.countyKey
        ) {
          logger.warn(
            {
              location: resolution.location,
              expectedCounty: resolution.countyKey,
              snapshotCounty: parsed.data.county,
            },
            "Coverage snapshot county mismatch — ignoring",
          );
        } else {
          snapshot = parsed.data;
        }
      } else {
        logger.warn(
          { location: resolution.location, error: parsed.error.message },
          "Coverage snapshot failed schema validation — ignoring",
        );
      }
    }
  } catch (err) {
    logger.warn(
      {
        location: resolution.location,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to read coverage snapshot — ignoring",
    );
  }

  // Only cache successful reads. Caching a null (transient gateway error,
  // DNS failure, missing file, or county mismatch) would suppress `datasets[]`
  // for the full TTL even once the underlying read recovers.
  if (snapshot !== null) {
    coverageCache.set(cacheKey, { snapshot, fetchedAt: now });
  }
  return snapshot;
}

/**
 * Derive the completion percent for a coverage row: round(ingested/expected
 * * 100) when a positive expected count is present, else null.
 *
 * @param ingested - Rows ingested so far.
 * @param expected - Target row count, or null/undefined.
 * @returns Whole-number percent, or null.
 */
export function computeCompletionPercent(
  ingested: number,
  expected: number | null | undefined,
): number | null {
  if (expected === null || expected === undefined || expected <= 0) {
    return null;
  }
  return Math.round((ingested / expected) * 100);
}

/**
 * Map a snapshot row to the camelCase `datasets[]` entry with completion %.
 *
 * @param row - Raw snapshot row.
 * @returns Normalized coverage entry.
 */
export function toDatasetInfoCoverageEntry(
  row: OracleDatasetCoverageRow,
): OracleDatasetInfoCoverageEntry {
  return {
    source: row.source,
    ingestedCount: row.ingested_count,
    expectedCount: row.expected_count ?? null,
    completionPercent: computeCompletionPercent(
      row.ingested_count,
      row.expected_count,
    ),
    firstLoadedAt: row.first_loaded_at ?? null,
    lastLoadedAt: row.last_loaded_at ?? null,
    cid: row.cid ?? null,
    ipnsLabel: row.ipns_label ?? null,
  };
}

/**
 * Load the per-source coverage entries for a county, sorted by source. Returns
 * null when no coverage is configured/available so callers can omit the field.
 *
 * @param county - Requested county.
 * @returns Coverage entries, or null.
 */
export async function getDatasetCoverageEntries(
  county: string | undefined,
): Promise<OracleDatasetInfoCoverageEntry[] | null> {
  const snapshot = await fetchDatasetCoverage(county);
  if (snapshot === null) {
    return null;
  }
  return [...snapshot.datasets]
    .map(toDatasetInfoCoverageEntry)
    .sort((a, b) => a.source.localeCompare(b.source));
}
