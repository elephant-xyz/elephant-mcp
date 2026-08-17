import { readFile } from "node:fs/promises";

import { logger } from "../logger.ts";
import { normalizeCountyKey } from "./countyIpnsRegistry.ts";
import {
  OracleDatasetCoverageSnapshotSchema,
  type OracleDatasetCoverageRow,
  type OracleDatasetCoverageSnapshot,
  type OracleDatasetInfoCoverageEntry,
} from "../types/oracleOpenData.ts";
import { CORPORATE_SCOPE_NOTE } from "./corporateManifest.ts";
import {
  ROCK_ISLAND_PERMIT_COUNTY_KEY,
  ROCK_ISLAND_PERMIT_SCOPE_NOTE,
} from "./rockIslandPermit.ts";
import {
  extractIpnsName,
  filebaseCidUrl,
  parseCountyCidFallbackMap,
} from "./cidFallback.ts";
import { resolveIpnsToCid } from "./oracleManifest.ts";

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
 *   DATASET_COVERAGE_MAP_ADDITIONS – strict highest-priority public URL additions
 *   DATASET_COVERAGE      – legacy single-county location (fallback)
 *   DATASET_COVERAGE_DEFAULT_COUNTY – county the single location serves
 *
 * A <location> is EITHER a local filesystem path OR an http(s) URL (e.g. an
 * IPNS gateway URL like https://ipfs.filebase.io/ipns/<name>/dataset-coverage.json).
 */

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SNAPSHOT_TIMEOUT_MS = 12_000;
const DEFAULT_CACHE_KEY = "__default__";
const COVERAGE_CID_FALLBACK_MAP_ENV =
  "DATASET_COVERAGE_CID_FALLBACK_MAP_ADDITIONS";

export const DEFAULT_DATASET_COVERAGE_MAP: Readonly<Record<string, string>> = {
  lee: "https://k51qzi5uqu5dimw0elyh4agbtqe7v2fzp0jcd7b1bcu8kxs0hml7yu1no0z0vd.ipns.dweb.link/",
  "miami-dade":
    "https://k51qzi5uqu5djj45hvhz6z2dnsdg6pkgucds99t0f78d5gmwu19bfv8o9tygno.ipns.dweb.link/",
  orange:
    "https://k51qzi5uqu5dj8n2f8nowh8kts53rvpr62zfj0mz9izc11rfzv56q7m4161lg7.ipns.dweb.link/",
  "palm-beach":
    "https://k51qzi5uqu5djwga4mcd8nx1gbwy4o9rks3gkoe1u5py5wi9tieea7h44nh4g2.ipns.dweb.link/",
  "rock-island":
    "https://k51qzi5uqu5disduz18ogkvf3f2zgdsizl20o034fu8spgh2khri8uxmeo3khv.ipns.dweb.link/",
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
 * Parse a strict additive coverage map.
 *
 * This layer exists for deployments where the base coverage map must remain
 * untouched or cannot be read back. It has explicit highest precedence, so a
 * newly approved immutable snapshot can supersede one county's stale base URL
 * without replacing or dropping any other configured county.
 *
 * @param raw - JSON object mapping county names to absolute HTTP(S) URLs.
 * @returns Validated normalized county additions.
 * @throws {Error} When the supplied JSON or any entry is invalid.
 */
export function parseCoverageMapAdditions(
  raw: string | undefined,
): Record<string, string> {
  if (!raw || raw.trim() === "") {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `DATASET_COVERAGE_MAP_ADDITIONS contains invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("DATASET_COVERAGE_MAP_ADDITIONS must be a JSON object");
  }

  const additions: Record<string, string> = {};
  for (const [county, rawLocation] of Object.entries(parsed)) {
    const countyKey = normalizeCountyKey(county);
    if (countyKey === "") {
      throw new Error(
        "DATASET_COVERAGE_MAP_ADDITIONS contains a blank county key",
      );
    }
    if (typeof rawLocation !== "string" || rawLocation.trim() === "") {
      throw new Error(
        `DATASET_COVERAGE_MAP_ADDITIONS entry '${countyKey}' must be a non-empty string URL`,
      );
    }
    const location = rawLocation.trim();
    let url: URL;
    try {
      url = new URL(location);
    } catch {
      throw new Error(
        `DATASET_COVERAGE_MAP_ADDITIONS entry '${countyKey}' must be an absolute HTTP(S) URL`,
      );
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(
        `DATASET_COVERAGE_MAP_ADDITIONS entry '${countyKey}' must use http: or https:`,
      );
    }
    additions[countyKey] = location;
  }
  return additions;
}

/** Parse reviewed per-county coverage snapshot CID fallbacks. */
export function parseCoverageCidFallbackMap(
  raw: string | undefined,
): Record<string, string> {
  return parseCountyCidFallbackMap(raw, COVERAGE_CID_FALLBACK_MAP_ENV);
}

/**
 * Resolve a stable coverage IPNS URL before selecting its reviewed immutable
 * county fallback.
 *
 * @param location - Stable county coverage URL.
 * @param countyKey - Normalized county key, or null in legacy single mode.
 * @returns The original stable URL when no fallback is configured, otherwise
 * the reviewed direct-CID URL after attempting IPNS resolution.
 * @throws {Error} When a county fallback is paired with a non-IPNS base URL.
 */
export async function resolveCoverageRuntimeLocation(
  location: string,
  countyKey: string | null,
): Promise<string> {
  const expectedByCounty = parseCoverageCidFallbackMap(
    process.env[COVERAGE_CID_FALLBACK_MAP_ENV],
  );
  const expectedCid =
    countyKey === null ? undefined : expectedByCounty[countyKey];
  if (expectedCid === undefined) return location;

  const ipnsName = extractIpnsName(location);
  if (ipnsName === null) {
    throw new Error(
      `${COVERAGE_CID_FALLBACK_MAP_ENV} requires the base route for '${countyKey}' to remain an IPNS URL`,
    );
  }
  const resolvedCid = await resolveIpnsToCid(ipnsName);
  if (resolvedCid !== expectedCid) {
    logger.warn(
      { county: countyKey, ipnsName, resolvedCid, fallbackCid: expectedCid },
      "Coverage IPNS is stale or unavailable; using reviewed CID fallback",
    );
  }
  return filebaseCidUrl(expectedCid);
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
  const baseMap = {
    ...DEFAULT_DATASET_COVERAGE_MAP,
    ...parseCoverageMap(process.env.DATASET_COVERAGE_MAP),
  };
  const map = {
    ...baseMap,
    ...parseCoverageMapAdditions(process.env.DATASET_COVERAGE_MAP_ADDITIONS),
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
    const immutableFallbacks = parseCoverageCidFallbackMap(
      process.env[COVERAGE_CID_FALLBACK_MAP_ENV],
    );
    const stableBase = baseMap[requestedKey];
    if (
      immutableFallbacks[requestedKey] !== undefined &&
      stableBase !== undefined
    ) {
      return {
        served: true,
        location: stableBase,
        countyKey: requestedKey,
      };
    }
    return { served: true, location: mapped, countyKey: requestedKey };
  }

  if (
    single !== null &&
    (defaultCountyKey === null || requestedKey === defaultCountyKey)
  ) {
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
    const runtimeLocation = await resolveCoverageRuntimeLocation(
      resolution.location,
      resolution.countyKey,
    );
    const raw = await readSnapshotJson(runtimeLocation);
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
              location: runtimeLocation,
              expectedCounty: resolution.countyKey,
              snapshotCounty: parsed.data.county,
            },
            "Coverage snapshot county mismatch — ignoring",
          );
        } else if (
          parsed.data.datasets.some(
            (row) => normalizeCountyKey(row.county) !== snapshotCountyKey,
          )
        ) {
          logger.warn(
            {
              location: runtimeLocation,
              snapshotCounty: parsed.data.county,
            },
            "Coverage snapshot contains a row for another county — ignoring",
          );
        } else {
          snapshot = parsed.data;
        }
      } else {
        logger.warn(
          { location: runtimeLocation, error: parsed.error.message },
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
  const entry: OracleDatasetInfoCoverageEntry = {
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
  const publishedScopeNote = row.scope_note ?? null;
  if (publishedScopeNote !== null) {
    entry.scopeNote = publishedScopeNote;
  } else if (row.source === "corporate") {
    entry.scopeNote = CORPORATE_SCOPE_NOTE;
  } else if (
    row.source === "permits" &&
    normalizeCountyKey(row.county) === ROCK_ISLAND_PERMIT_COUNTY_KEY
  ) {
    entry.scopeNote = ROCK_ISLAND_PERMIT_SCOPE_NOTE;
  }
  return entry;
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
