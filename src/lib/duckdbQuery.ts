import { tmpdir } from "node:os";
import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection, DuckDBValue, Json } from "@duckdb/node-api";
import { logger } from "../logger.ts";
import { normalizeCountyKey } from "./countyIpnsRegistry.ts";
import {
  CORPORATE_ALLOWED_COUNTY_KEYS,
  CORPORATE_PUBLIC_DUCKDB_SCHEMA,
  resolveCorporateParquetLocation,
} from "./corporateManifest.ts";
import {
  ROCK_ISLAND_PERMIT_COUNTY_KEY,
  ROCK_ISLAND_PERMIT_PUBLIC_DUCKDB_SCHEMA,
} from "./rockIslandPermit.ts";
import {
  extractIpnsName,
  filebaseCidUrl,
  parseCountyCidFallbackMap,
} from "./cidFallback.ts";
import { resolveIpnsToCid } from "./oracleManifest.ts";

/**
 * Embedded DuckDB query engine over per-county Parquet "query tables".
 *
 * Step 2 of the DuckDB-on-IPFS indexing feature. Each county's flat, one-row-
 * per-record Parquet is exposed to callers as a stable view. An in-process
 * DuckDB reads it directly (local path) or via HTTP range reads (IPFS gateway
 * URL), so the donphan agent can answer arbitrary questions with plain SQL.
 *
 * Three datasets share ALL of this machinery (SQL safety, env resolution,
 * connection caching), differing only in a small {@link DatasetConfig}:
 *   - PROPERTIES: one row per property, view `properties`, env
 *     PROPERTY_QUERY_TABLE_MAP / PROPERTY_QUERY_TABLE /
 *     PROPERTY_QUERY_TABLE_DEFAULT_COUNTY (Lee runs this in prod).
 *   - PERMITS: one row per building permit, view `permits`, env
 *     PERMIT_QUERY_TABLE_MAP / PERMIT_QUERY_TABLE /
 *     PERMIT_QUERY_TABLE_DEFAULT_COUNTY.
 *   - CORPORATIONS: one public organization-registry row per Illinois file
 *     number, view `corporations`, with a stable IPNS manifest selected through
 *     CORPORATE_REGISTRATION_MANIFEST_MAP(_ADDITIONS).
 *
 * A <location> is EITHER a local filesystem path OR an http(s) URL.
 *
 * Safety: callers never touch the DuckDB connection directly. Every caller-
 * facing query goes through {@link runPropertyQuery}, {@link runPermitQuery},
 * or {@link runCorporateQuery},
 * which accept a SINGLE read-only SELECT statement (see
 * {@link validateSelectQuery}) and always cap the returned rows.
 */

/** The stable view name the property query table is exposed under. */
export const PROPERTIES_VIEW = "properties";

/** The stable view name the permit query table is exposed under. */
export const PERMITS_VIEW = "permits";

/** The stable view name the corporate-registration table is exposed under. */
export const CORPORATIONS_VIEW = "corporations";

/** Default row cap when the caller does not specify one. */
export const DEFAULT_ROW_LIMIT = 100;

/** Hard upper bound on returned rows, so results can't blow the agent context. */
export const MAX_ROW_LIMIT = 1000;
const PROPERTY_QUERY_CID_FALLBACK_MAP_ENV =
  "PROPERTY_QUERY_TABLE_CID_FALLBACK_MAP_ADDITIONS";
const PERMIT_QUERY_CID_FALLBACK_MAP_ENV =
  "PERMIT_QUERY_TABLE_CID_FALLBACK_MAP_ADDITIONS";

/**
 * Statement-level keywords that must never appear in a caller's query. These
 * cover data mutation and any file/extension side effects DuckDB can perform
 * (COPY … TO writes files; ATTACH/INSTALL/LOAD reach outside the view). The
 * check runs against a literal- and comment-stripped copy of the SQL so a value
 * like `'copy'` inside a string never trips it.
 */
const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "UPSERT",
  "CREATE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "REPLACE",
  "ATTACH",
  "DETACH",
  "COPY",
  "EXPORT",
  "IMPORT",
  "INSTALL",
  "LOAD",
  "PRAGMA",
  "CALL",
  "SET",
  "RESET",
  "VACUUM",
  "CHECKPOINT",
  "USE",
] as const;

/** Leading keywords that begin a read-only query (a plain SELECT or a CTE). */
const READ_ONLY_LEADING_KEYWORDS = new Set(["SELECT", "WITH"]);

export interface QueryTableResolution {
  /** Whether this deployment serves a query table for the requested county. */
  readonly served: boolean;
  /** The resolved Parquet location (local path or http(s) URL), or null. */
  readonly location: string | null;
  /** The normalized county key that was resolved (null when none requested). */
  readonly countyKey: string | null;
}

interface CountyConnection {
  readonly connection: DuckDBConnection;
  readonly location: string;
  /** Serializes operations so an interrupt cannot cancel a different request. */
  tail: Promise<void>;
}

/**
 * The per-dataset configuration that specializes the shared DuckDB machinery.
 * Everything else (SQL safety, env resolution, connection caching) is generic
 * over this. Each dataset owns its OWN connection cache so a property and a
 * permit table for the same county never collide on a cache key.
 */
interface DatasetConfig {
  /** The view name the parquet is exposed under (e.g. `properties`, `permits`). */
  readonly view: string;
  /** JSON county→location map env var (e.g. `PROPERTY_QUERY_TABLE_MAP`). */
  readonly mapEnv: string;
  /**
   * Optional strict JSON map whose entries are added without allowing them to
   * replace conflicting entries from {@link mapEnv}.
   */
  readonly additionsEnv?: string;
  /** Single-location fallback env var (e.g. `PROPERTY_QUERY_TABLE`). */
  readonly singleEnv: string;
  /** Default-county env var for the single location (e.g. `..._DEFAULT_COUNTY`). */
  readonly defaultCountyEnv: string;
  /** This dataset's private connection cache, keyed by countyKey + location. */
  readonly connectionCache: Map<string, Promise<CountyConnection>>;
  /** Optional explicit county allowlist applied before any source read. */
  readonly allowedCountyKeys?: readonly string[];
  /**
   * Optional asynchronous resolution from a stable manifest location to the
   * immutable current Parquet location.
   */
  readonly resolveRuntimeLocation?: (
    location: string,
    countyKey: string | null,
  ) => Promise<string>;
  /** Optional exact source schema; any added, removed, reordered, or retyped column fails. */
  readonly expectedSchema?: Readonly<Record<string, string>>;
  /** Optional exact source schemas applied only to named normalized counties. */
  readonly expectedSchemaByCounty?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  /**
   * Whether to materialize the allowlisted source into memory and disable all
   * external filesystem access before caller SQL can run.
   */
  readonly materializeAndLockExternalAccess?: boolean;
  /** County keys that require materialization and engine-level external-access denial. */
  readonly materializeAndLockExternalAccessCountyKeys?: readonly string[];
  /** Whether caller SQL must resolve every FROM/JOIN relation to this view or a CTE. */
  readonly requireViewOnlyQuery?: boolean;
}

/** Parse reviewed per-county property query-table CID fallbacks. */
export function parsePropertyQueryCidFallbackMap(
  raw: string | undefined,
): Record<string, string> {
  return parseCountyCidFallbackMap(raw, PROPERTY_QUERY_CID_FALLBACK_MAP_ENV);
}

/**
 * Resolve stable property-query IPNS before selecting an immutable fallback.
 *
 * The fallback is county-scoped and temporary: when IPNS resolves to the
 * reviewed CID, the direct CID URL avoids a second gateway resolution; when
 * IPNS is stale/unavailable, the same reviewed CID prevents serving old bytes.
 */
export async function resolvePropertyQueryRuntimeLocation(
  location: string,
  countyKey: string | null,
): Promise<string> {
  const expectedByCounty = parsePropertyQueryCidFallbackMap(
    process.env[PROPERTY_QUERY_CID_FALLBACK_MAP_ENV],
  );
  const expectedCid =
    countyKey === null ? undefined : expectedByCounty[countyKey];
  if (expectedCid === undefined) return location;

  const ipnsName = extractIpnsName(location);
  if (ipnsName === null) {
    throw new Error(
      `${PROPERTY_QUERY_CID_FALLBACK_MAP_ENV} requires the base route for '${countyKey}' to remain an IPNS URL`,
    );
  }
  const resolvedCid = await resolveIpnsToCid(ipnsName);
  if (resolvedCid !== expectedCid) {
    logger.warn(
      { county: countyKey, ipnsName, resolvedCid, fallbackCid: expectedCid },
      "Property query IPNS is stale or unavailable; using reviewed CID fallback",
    );
  }
  return filebaseCidUrl(expectedCid);
}

/** Parse reviewed per-county permit query-table CID fallbacks. */
export function parsePermitQueryCidFallbackMap(
  raw: string | undefined,
): Record<string, string> {
  return parseCountyCidFallbackMap(raw, PERMIT_QUERY_CID_FALLBACK_MAP_ENV);
}

/**
 * Keep the stable permit IPNS route primary while selecting a reviewed
 * immutable CID when gateway propagation is stale.
 *
 * @param location - Configured stable permit IPNS URL.
 * @param countyKey - Normalized county key.
 * @returns Immutable Filebase gateway URL when a reviewed fallback is set.
 */
export async function resolvePermitQueryRuntimeLocation(
  location: string,
  countyKey: string | null,
): Promise<string> {
  const expectedByCounty = parsePermitQueryCidFallbackMap(
    process.env[PERMIT_QUERY_CID_FALLBACK_MAP_ENV],
  );
  const expectedCid =
    countyKey === null ? undefined : expectedByCounty[countyKey];
  if (expectedCid === undefined) return location;

  const ipnsName = extractIpnsName(location);
  if (ipnsName === null) {
    throw new Error(
      `${PERMIT_QUERY_CID_FALLBACK_MAP_ENV} requires the base route for '${countyKey}' to remain an IPNS URL`,
    );
  }
  const resolvedCid = await resolveIpnsToCid(ipnsName);
  if (resolvedCid !== expectedCid) {
    logger.warn(
      { county: countyKey, ipnsName, resolvedCid, fallbackCid: expectedCid },
      "Permit query IPNS is stale or unavailable; using reviewed CID fallback",
    );
  }
  return filebaseCidUrl(expectedCid);
}

const PROPERTY_DATASET: DatasetConfig = {
  view: PROPERTIES_VIEW,
  mapEnv: "PROPERTY_QUERY_TABLE_MAP",
  additionsEnv: "PROPERTY_QUERY_TABLE_MAP_ADDITIONS",
  singleEnv: "PROPERTY_QUERY_TABLE",
  defaultCountyEnv: "PROPERTY_QUERY_TABLE_DEFAULT_COUNTY",
  connectionCache: new Map<string, Promise<CountyConnection>>(),
  resolveRuntimeLocation: resolvePropertyQueryRuntimeLocation,
};

const PERMIT_DATASET: DatasetConfig = {
  view: PERMITS_VIEW,
  mapEnv: "PERMIT_QUERY_TABLE_MAP",
  additionsEnv: "PERMIT_QUERY_TABLE_MAP_ADDITIONS",
  singleEnv: "PERMIT_QUERY_TABLE",
  defaultCountyEnv: "PERMIT_QUERY_TABLE_DEFAULT_COUNTY",
  connectionCache: new Map<string, Promise<CountyConnection>>(),
  expectedSchemaByCounty: {
    [ROCK_ISLAND_PERMIT_COUNTY_KEY]: ROCK_ISLAND_PERMIT_PUBLIC_DUCKDB_SCHEMA,
  },
  materializeAndLockExternalAccessCountyKeys: [ROCK_ISLAND_PERMIT_COUNTY_KEY],
  requireViewOnlyQuery: true,
  resolveRuntimeLocation: resolvePermitQueryRuntimeLocation,
};

const CORPORATE_DATASET: DatasetConfig = {
  view: CORPORATIONS_VIEW,
  mapEnv: "CORPORATE_REGISTRATION_MANIFEST_MAP",
  additionsEnv: "CORPORATE_REGISTRATION_MANIFEST_MAP_ADDITIONS",
  singleEnv: "CORPORATE_REGISTRATION_MANIFEST",
  defaultCountyEnv: "CORPORATE_REGISTRATION_DEFAULT_COUNTY",
  connectionCache: new Map<string, Promise<CountyConnection>>(),
  allowedCountyKeys: CORPORATE_ALLOWED_COUNTY_KEYS,
  resolveRuntimeLocation: resolveCorporateParquetLocation,
  expectedSchema: CORPORATE_PUBLIC_DUCKDB_SCHEMA,
  materializeAndLockExternalAccess: true,
  requireViewOnlyQuery: true,
};

/**
 * Parse a JSON county→location map env value (generic core). Returns an empty
 * map when unset, blank, or malformed — the failure is logged (naming the env
 * var) so a bad config is visible without crashing the server. Keys are
 * normalized; blank/non-string values are skipped.
 */
function parseDatasetMap(
  raw: string | undefined,
  mapEnv: string,
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
      `Failed to parse ${mapEnv} JSON — ignoring (falling back to single query table)`,
    );
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    logger.warn(`${mapEnv} is not a JSON object — ignoring`);
    return {};
  }

  const map: Record<string, string> = {};
  for (const [county, location] of Object.entries(parsed)) {
    if (typeof location !== "string" || location.trim() === "") {
      logger.warn(
        { county },
        `Skipping ${mapEnv} entry with a non-string/blank location`,
      );
      continue;
    }
    map[normalizeCountyKey(county)] = location.trim();
  }

  return map;
}

/**
 * Parse a strict county→HTTP(S) URL additions map.
 *
 * Unlike the legacy base-map parser, additions must fail closed: malformed
 * JSON, non-object input, blank county keys, non-string values, and non-HTTP(S)
 * URLs all throw a descriptive configuration error. This prevents an invalid
 * additive deployment setting from silently dropping a newly published county.
 *
 * @param raw - Raw JSON environment variable value.
 * @param additionsEnv - Environment variable name used in error messages.
 * @returns Normalized county keys mapped to trimmed absolute HTTP(S) URLs.
 * @throws {Error} When the additions value is present but invalid.
 */
function parseDatasetMapAdditions(
  raw: string | undefined,
  additionsEnv: string,
): Record<string, string> {
  if (!raw || raw.trim() === "") {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${additionsEnv} contains invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${additionsEnv} must be a JSON object`);
  }

  const additions: Record<string, string> = {};
  for (const [county, rawLocation] of Object.entries(parsed)) {
    const countyKey = normalizeCountyKey(county);
    if (countyKey === "") {
      throw new Error(`${additionsEnv} contains a blank county key`);
    }
    if (typeof rawLocation !== "string" || rawLocation.trim() === "") {
      throw new Error(
        `${additionsEnv} entry '${countyKey}' must be a non-empty string URL`,
      );
    }

    const location = rawLocation.trim();
    let url: URL;
    try {
      url = new URL(location);
    } catch {
      throw new Error(
        `${additionsEnv} entry '${countyKey}' must be an absolute HTTP(S) URL`,
      );
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(
        `${additionsEnv} entry '${countyKey}' must use http: or https:`,
      );
    }
    additions[countyKey] = location;
  }

  return additions;
}

/**
 * Merge a base county map with validated additions without allowing overrides.
 *
 * A duplicate county is idempotent when both maps contain the exact same
 * location. A different location is a configuration conflict and throws before
 * any query-table location is returned.
 *
 * @param base - Parsed base county→location map.
 * @param additions - Parsed additions county→location map.
 * @param baseEnv - Base environment variable name used in errors.
 * @param additionsEnv - Additions environment variable name used in errors.
 * @returns A new map containing every base entry plus non-conflicting additions.
 * @throws {Error} When an addition conflicts with an existing county value.
 */
function mergeDatasetMaps(
  base: Readonly<Record<string, string>>,
  additions: Readonly<Record<string, string>>,
  baseEnv: string,
  additionsEnv: string,
): Record<string, string> {
  const merged = { ...base };
  for (const [countyKey, location] of Object.entries(additions)) {
    const existing = merged[countyKey];
    if (existing !== undefined && existing !== location) {
      throw new Error(
        `${additionsEnv} conflicts with ${baseEnv} for county '${countyKey}'`,
      );
    }
    merged[countyKey] = location;
  }
  return merged;
}

/**
 * Read and merge the configured map layers for one query-table dataset.
 *
 * @param config - Dataset-specific environment contract.
 * @returns Effective county→location map.
 */
function getDatasetMap(config: DatasetConfig): Record<string, string> {
  const base = parseDatasetMap(process.env[config.mapEnv], config.mapEnv);
  if (config.additionsEnv === undefined) {
    return base;
  }
  const additions = parseDatasetMapAdditions(
    process.env[config.additionsEnv],
    config.additionsEnv,
  );
  return mergeDatasetMaps(base, additions, config.mapEnv, config.additionsEnv);
}

/**
 * Resolve the Parquet location to read for the given county (generic core).
 *
 * - No map configured (legacy mode): always resolve to the single location.
 * - Map configured: county in the map → its location; county equals the
 *   configured default county → the single location; otherwise → not served.
 */
function resolveDatasetLocation(
  config: DatasetConfig,
  county: string | undefined,
): QueryTableResolution {
  const map = getDatasetMap(config);
  const single = process.env[config.singleEnv]?.trim() || null;
  const defaultCountyKey = process.env[config.defaultCountyEnv]
    ? normalizeCountyKey(process.env[config.defaultCountyEnv] as string)
    : null;
  const requestedKey = county ? normalizeCountyKey(county) : defaultCountyKey;

  if (
    config.allowedCountyKeys !== undefined &&
    (requestedKey === null || !config.allowedCountyKeys.includes(requestedKey))
  ) {
    return { served: false, location: null, countyKey: requestedKey };
  }

  if (Object.keys(map).length === 0) {
    return {
      served: single !== null,
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

  if (defaultCountyKey !== null && requestedKey === defaultCountyKey) {
    return {
      served: single !== null,
      location: single,
      countyKey: requestedKey,
    };
  }

  return { served: false, location: null, countyKey: requestedKey };
}

/**
 * Resolve the county a dataset-backed tool should target when the caller did not
 * name one (generic core). Returns the sole county key when the map has exactly
 * one entry; the configured default county otherwise; null when neither applies.
 */
function resolveDefaultDatasetCounty(config: DatasetConfig): string | null {
  const map = getDatasetMap(config);
  const keys = Object.keys(map);
  if (keys.length === 1) {
    return keys[0] ?? null;
  }
  const defaultCounty = process.env[config.defaultCountyEnv]?.trim();
  if (defaultCounty) {
    return normalizeCountyKey(defaultCounty);
  }
  return null;
}

// ---------------------------------------------------------------------------
// PROPERTY dataset — public API (exact signatures/behavior preserved).
// ---------------------------------------------------------------------------

/**
 * Parse the PROPERTY_QUERY_TABLE_MAP env var (a JSON object of
 * county → Parquet location). Returns an empty map when unset, blank, or
 * malformed. Keys are normalized; blank/non-string values are skipped.
 */
export function parseQueryTableMap(
  raw: string | undefined,
): Record<string, string> {
  return parseDatasetMap(raw, PROPERTY_DATASET.mapEnv);
}

/**
 * Parse `PROPERTY_QUERY_TABLE_MAP_ADDITIONS` with strict validation.
 *
 * @param raw - Raw JSON additions value.
 * @returns Normalized county→absolute HTTP(S) URL additions.
 * @throws {Error} When the value is malformed or contains an invalid entry.
 */
export function parseQueryTableMapAdditions(
  raw: string | undefined,
): Record<string, string> {
  if (PROPERTY_DATASET.additionsEnv === undefined) {
    throw new Error("Property query-table additions are not configured");
  }
  return parseDatasetMapAdditions(raw, PROPERTY_DATASET.additionsEnv);
}

/** Resolve the property Parquet location to read for the given county. */
export function resolveQueryTableLocation(
  county: string | undefined,
): QueryTableResolution {
  return resolveDatasetLocation(PROPERTY_DATASET, county);
}

/**
 * Whether this deployment can serve the requested county from a per-county
 * property query table (DuckDB over Parquet).
 */
export function isCountyServedByQueryTable(
  county: string | undefined,
): boolean {
  return resolveDatasetLocation(PROPERTY_DATASET, county).served;
}

/**
 * Resolve the property county a query-table-backed tool should target when the
 * caller did not name one.
 */
export function resolveDefaultQueryTableCounty(): string | null {
  return resolveDefaultDatasetCounty(PROPERTY_DATASET);
}

// ---------------------------------------------------------------------------
// PERMIT dataset — public API (parallel surface).
// ---------------------------------------------------------------------------

/**
 * Parse the PERMIT_QUERY_TABLE_MAP env var (a JSON object of
 * county → Parquet location). Same semantics as {@link parseQueryTableMap}.
 */
export function parsePermitQueryTableMap(
  raw: string | undefined,
): Record<string, string> {
  return parseDatasetMap(raw, PERMIT_DATASET.mapEnv);
}

/**
 * Parse `PERMIT_QUERY_TABLE_MAP_ADDITIONS` with strict validation.
 *
 * @param raw - Raw JSON additions value.
 * @returns Normalized county→absolute HTTP(S) URL additions.
 * @throws {Error} When the value is malformed or contains an invalid entry.
 */
export function parsePermitQueryTableMapAdditions(
  raw: string | undefined,
): Record<string, string> {
  if (PERMIT_DATASET.additionsEnv === undefined) {
    throw new Error("Permit query-table additions are not configured");
  }
  return parseDatasetMapAdditions(raw, PERMIT_DATASET.additionsEnv);
}

/** Resolve the permit Parquet location to read for the given county. */
export function resolvePermitTableLocation(
  county: string | undefined,
): QueryTableResolution {
  return resolveDatasetLocation(PERMIT_DATASET, county);
}

/**
 * Whether this deployment can serve the requested county from a per-county
 * permit query table (DuckDB over Parquet).
 */
export function isCountyServedByPermitTable(
  county: string | undefined,
): boolean {
  return resolveDatasetLocation(PERMIT_DATASET, county).served;
}

/**
 * Resolve the permit county a query-table-backed tool should target when the
 * caller did not name one.
 */
export function resolveDefaultPermitTableCounty(): string | null {
  return resolveDefaultDatasetCounty(PERMIT_DATASET);
}

// ---------------------------------------------------------------------------
// CORPORATE dataset — public routing API.
// ---------------------------------------------------------------------------

/**
 * Parse the base corporate county→stable-manifest map.
 *
 * @param raw - JSON object mapping county names to public manifest locations.
 * @returns Normalized county keys and non-blank locations.
 */
export function parseCorporateManifestMap(
  raw: string | undefined,
): Record<string, string> {
  return parseDatasetMap(raw, CORPORATE_DATASET.mapEnv);
}

/**
 * Parse strict additive corporate manifest mappings.
 *
 * @param raw - JSON object mapping counties to absolute HTTP(S) manifest URLs.
 * @returns Validated normalized additions.
 * @throws {Error} When JSON or any URL is invalid.
 */
export function parseCorporateManifestMapAdditions(
  raw: string | undefined,
): Record<string, string> {
  if (CORPORATE_DATASET.additionsEnv === undefined) {
    throw new Error("Corporate manifest-map additions are not configured");
  }
  return parseDatasetMapAdditions(raw, CORPORATE_DATASET.additionsEnv);
}

/**
 * Resolve the stable public corporate manifest for one explicitly named county.
 *
 * @param county - Requested county name or slug.
 * @returns Allowlisted county routing result.
 */
export function resolveCorporateManifestLocation(
  county: string | undefined,
): QueryTableResolution {
  return resolveDatasetLocation(CORPORATE_DATASET, county);
}

/**
 * Strip SQL string literals, quoted identifiers, and comments so keyword checks
 * never match text inside a value (e.g. `owners_text ILIKE '%copy%'`). Removed
 * spans are replaced with a space to preserve token boundaries.
 */
function stripLiteralsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Line comment: -- … end of line
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i += 1;
      out += " ";
      continue;
    }

    // Block comment: /* … */
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }

    // Single-quoted string or double-quoted identifier (doubled quote escapes)
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

export type SelectValidation =
  | { readonly ok: true; readonly sql: string }
  | { readonly ok: false; readonly error: string };

/**
 * Validate that `sql` is a single, read-only SELECT statement.
 *
 * Rules (documented on the tool):
 *  - non-empty; a single statement only (no `;`-separated second statement);
 *  - must begin with SELECT or WITH (a CTE that feeds a SELECT);
 *  - must not contain any data-mutating or file/extension keyword.
 *
 * Returns the cleaned statement (trailing `;` and whitespace removed) on
 * success, or an explanatory error.
 */
export function validateSelectQuery(sql: string): SelectValidation {
  const trimmed = sql.trim();
  if (trimmed === "") {
    return { ok: false, error: "SQL query must not be empty." };
  }

  const analyzed = stripLiteralsAndComments(trimmed);

  // Reject multiple statements: a `;` anywhere other than trailing whitespace.
  const withoutTrailing = analyzed.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return {
      ok: false,
      error:
        "Only a single SELECT statement is allowed — multiple statements are rejected.",
    };
  }

  const leading = withoutTrailing
    .trimStart()
    .split(/[\s(]/, 1)[0]
    ?.toUpperCase();
  if (!leading || !READ_ONLY_LEADING_KEYWORDS.has(leading)) {
    return {
      ok: false,
      error:
        "Only read-only SELECT queries are allowed (the statement must begin with SELECT or WITH).",
    };
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    const pattern = new RegExp(`\\b${keyword}\\b`, "i");
    if (pattern.test(withoutTrailing)) {
      return {
        ok: false,
        error: `Disallowed keyword '${keyword}' — only read-only SELECT queries are permitted.`,
      };
    }
  }

  return { ok: true, sql: trimmed.replace(/;\s*$/, "") };
}

const EXTERNAL_TABLE_FUNCTION_PATTERN =
  /\b(?:read_[a-z0-9_]*|parquet_scan|csv_scan|glob|sqlite_scan|postgres_scan|mysql_scan|iceberg_scan|delta_scan|st_read)\s*\(/iu;

/**
 * Apply the general single-SELECT guard and restrict relations to one public
 * view plus CTE aliases defined inside the same statement.
 *
 * External table functions are rejected explicitly. The corporate connection
 * also disables DuckDB external access after materializing the approved
 * Parquet, so this static guard is backed by an engine-level deny rule.
 *
 * @param sql - Caller-authored SQL.
 * @param view - The only base relation callers may reference.
 * @returns Validated SQL or a descriptive fail-closed error.
 */
export function validateSelectQueryForView(
  sql: string,
  view: string,
): SelectValidation {
  const general = validateSelectQuery(sql);
  if (!general.ok) {
    return general;
  }

  const analyzed = stripLiteralsAndComments(general.sql);
  if (EXTERNAL_TABLE_FUNCTION_PATTERN.test(analyzed)) {
    return {
      ok: false,
      error: `Only the '${view}' view may be queried; external table functions are rejected.`,
    };
  }

  const cteNames = new Set<string>();
  for (const match of analyzed.matchAll(/\b([a-z_][a-z0-9_$]*)\s+AS\s*\(/giu)) {
    const name = match[1];
    if (name !== undefined) {
      cteNames.add(name.toLowerCase());
    }
  }

  let referencesView = false;
  for (const match of analyzed.matchAll(
    /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?)/giu,
  )) {
    const relation = match[1]?.toLowerCase();
    if (relation === undefined) {
      continue;
    }
    if (relation === view.toLowerCase()) {
      referencesView = true;
      continue;
    }
    if (!relation.includes(".") && cteNames.has(relation)) {
      continue;
    }
    return {
      ok: false,
      error: `Only the '${view}' view and CTEs derived from it may appear in FROM/JOIN clauses.`,
    };
  }

  if (!referencesView) {
    return {
      ok: false,
      error: `The read-only query must reference the '${view}' view.`,
    };
  }
  return general;
}

// One DuckDB connection per resolved (county → location) PER DATASET. The MCP
// process is long-lived, so opening the instance once and reusing the view
// keeps per-query latency low. Keyed by countyKey + location so a config change
// (or a per-county location) never serves the wrong table. Each dataset holds
// its own cache (see DatasetConfig.connectionCache).

/** Reset all cached PROPERTY DuckDB connections. Intended for tests. */
export function clearPropertyQueryConnections(): void {
  PROPERTY_DATASET.connectionCache.clear();
}

/** Reset all cached PERMIT DuckDB connections. Intended for tests. */
export function clearPermitQueryConnections(): void {
  PERMIT_DATASET.connectionCache.clear();
}

/** Reset all cached CORPORATE DuckDB connections. Intended for tests. */
export function clearCorporateQueryConnections(): void {
  CORPORATE_DATASET.connectionCache.clear();
}

function isHttpLocation(location: string): boolean {
  return /^https?:\/\//i.test(location);
}

async function openCountyConnection(
  config: DatasetConfig,
  location: string,
  countyKey: string | null,
): Promise<CountyConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  if (isHttpLocation(location)) {
    // httpfs lets DuckDB range-read a Parquet served from an IPFS gateway.
    // INSTALL writes the extension under DuckDB's home directory; serverless
    // runtimes (e.g. Vercel Functions) start with an empty HOME, which makes
    // INSTALL fail with "Can't find the home directory at ''". Point the home
    // directory at a writable temp dir first (overridable via env).
    const homeDir = process.env.DUCKDB_HOME_DIRECTORY ?? tmpdir();
    await connection.run(`SET home_directory='${homeDir.replace(/'/g, "''")}'`);
    await connection.run("INSTALL httpfs");
    await connection.run("LOAD httpfs");
  }

  const escaped = location.replace(/'/g, "''");
  const countyExpectedSchema =
    countyKey === null ? undefined : config.expectedSchemaByCounty?.[countyKey];
  const expectedSchema = countyExpectedSchema ?? config.expectedSchema;
  const expectedSchemaEntries =
    expectedSchema === undefined ? null : Object.entries(expectedSchema);

  if (expectedSchemaEntries !== null) {
    const schemaReader = await connection.runAndReadAll(
      `DESCRIBE SELECT * FROM read_parquet('${escaped}')`,
    );
    const actualSchema = schemaReader.getRowObjectsJson().map((row) => ({
      name: String(row.column_name ?? ""),
      type: String(row.column_type ?? ""),
    }));
    const expectedSchema = expectedSchemaEntries.map(([name, type]) => ({
      name,
      type,
    }));
    if (JSON.stringify(actualSchema) !== JSON.stringify(expectedSchema)) {
      throw new Error(
        `${config.view} source schema drifted from the exact public allowlist`,
      );
    }
  }

  const shouldMaterializeAndLock =
    config.materializeAndLockExternalAccess === true ||
    (countyKey !== null &&
      config.materializeAndLockExternalAccessCountyKeys?.includes(countyKey) ===
        true);
  if (shouldMaterializeAndLock && expectedSchemaEntries !== null) {
    const projectedColumns = expectedSchemaEntries
      .map(([name]) => `"${name.replace(/"/gu, '""')}"`)
      .join(", ");
    const materializedTable = `__${config.view}_public_data`;
    await connection.run(
      `CREATE TEMP TABLE ${materializedTable} AS SELECT ${projectedColumns} FROM read_parquet('${escaped}')`,
    );
    await connection.run(
      `CREATE VIEW ${config.view} AS SELECT ${projectedColumns} FROM ${materializedTable}`,
    );
    await connection.run("SET enable_external_access=false");
  } else {
    await connection.run(
      `CREATE VIEW ${config.view} AS SELECT * FROM read_parquet('${escaped}')`,
    );
  }

  logger.info(
    { view: config.view, location },
    "Opened DuckDB query table view",
  );
  return { connection, location, tail: Promise.resolve() };
}

async function getCountyConnection(
  config: DatasetConfig,
  county: string | undefined,
): Promise<CountyConnection> {
  const resolution = resolveDatasetLocation(config, county);
  if (!resolution.served || resolution.location === null) {
    throw new Error(
      county
        ? `County '${county}' is not served by this deployment's ${config.view} query table.`
        : `No ${config.view} query table is configured — set ${config.singleEnv} or ${config.mapEnv}.`,
    );
  }

  const runtimeLocation =
    config.resolveRuntimeLocation === undefined
      ? resolution.location
      : await config.resolveRuntimeLocation(
          resolution.location,
          resolution.countyKey,
        );
  const cacheKey = `${resolution.countyKey ?? "__default__"}::${runtimeLocation}`;
  let pending = config.connectionCache.get(cacheKey);
  if (pending === undefined) {
    pending = openCountyConnection(
      config,
      runtimeLocation,
      resolution.countyKey,
    );
    config.connectionCache.set(cacheKey, pending);
    // Don't cache a failed open — let the next call retry.
    pending.catch(() => config.connectionCache.delete(cacheKey));
  }
  return pending;
}

/**
 * Run one operation exclusively on a cached county connection.
 *
 * DuckDB's interrupt API is connection-scoped. Serializing every operation
 * ensures cancellation can affect only the request that owns the connection.
 */
async function withCountyConnection<Result>(
  config: DatasetConfig,
  county: string | undefined,
  operation: (connection: DuckDBConnection) => Promise<Result>,
): Promise<Result> {
  const entry = await getCountyConnection(config, county);
  const predecessor = entry.tail;
  let release: (() => void) | undefined;
  entry.tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await predecessor;
  try {
    return await operation(entry.connection);
  } finally {
    release?.();
  }
}

/**
 * Run a DuckDB operation that can be cancelled by its MCP/web request.
 *
 * Cancellation reasons are intentionally excluded from the error so a
 * caller-controlled reason can never be copied into service logs.
 */
async function runWithCancellation<Result>(
  connection: DuckDBConnection,
  operation: () => Promise<Result>,
  signal?: AbortSignal,
): Promise<Result> {
  if (signal?.aborted) {
    throw new Error("Property query was cancelled before execution.");
  }

  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    try {
      connection.interrupt();
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to interrupt cancelled DuckDB property query",
      );
    }
  };
  signal?.addEventListener("abort", interrupt, { once: true });

  try {
    const result = await operation();
    if (interrupted) {
      throw new Error("Property query was cancelled during execution.");
    }
    return result;
  } catch (error) {
    if (interrupted) {
      throw new Error("Property query was cancelled during execution.");
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", interrupt);
  }
}

export interface PropertyQueryResult {
  readonly county: string | null;
  readonly rowCount: number;
  readonly limit: number;
  readonly rows: Array<Record<string, Json>>;
}

/**
 * Run a single validated, capped read-only SELECT against a dataset's view
 * (generic core shared by the property and permit query surfaces).
 */
async function runDatasetQuery(
  config: DatasetConfig,
  county: string,
  sql: string,
  limit: number,
  signal?: AbortSignal,
): Promise<PropertyQueryResult> {
  const validation =
    config.requireViewOnlyQuery === true
      ? validateSelectQueryForView(sql, config.view)
      : validateSelectQuery(sql);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const cappedLimit = Math.max(1, Math.min(limit, MAX_ROW_LIMIT));
  const wrapped = `SELECT * FROM (${validation.sql}) AS _q LIMIT ${cappedLimit}`;
  return withCountyConnection(config, county, async (connection) => {
    const reader = await runWithCancellation(
      connection,
      () => connection.runAndReadAll(wrapped),
      signal,
    );
    const rows = reader.getRowObjectsJson();

    return {
      county: county ?? null,
      rowCount: rows.length,
      limit: cappedLimit,
      rows,
    };
  });
}

/**
 * Run a TRUSTED, internal read-only query against a dataset's view (generic
 * core). Does NOT run the caller-facing validator or force a row cap: the SQL
 * here is authored by the data tools themselves, with all runtime values bound
 * as positional `$1…$n` parameters, so it is safe by construction.
 */
async function runInternalDatasetQuery(
  config: DatasetConfig,
  county: string | undefined,
  sql: string,
  params: DuckDBValue[],
): Promise<Array<Record<string, Json>>> {
  return withCountyConnection(config, county, async (connection) => {
    const reader = await connection.runAndReadAll(sql, params);
    return reader.getRowObjectsJson();
  });
}

export interface PropertyColumn {
  readonly name: string;
  readonly type: string;
}

/** Return the column names and DuckDB types of a dataset's view (generic core). */
async function getDatasetColumns(
  config: DatasetConfig,
  county: string,
  signal?: AbortSignal,
): Promise<PropertyColumn[]> {
  return withCountyConnection(config, county, async (connection) => {
    const reader = await runWithCancellation(
      connection,
      () => connection.runAndReadAll(`DESCRIBE ${config.view}`),
      signal,
    );
    const rows = reader.getRowObjectsJson();

    return rows.map((row) => ({
      name: String(row.column_name ?? ""),
      type: String(row.column_type ?? ""),
    }));
  });
}

// ---------------------------------------------------------------------------
// PROPERTY dataset — query API (exact signatures/behavior preserved).
// ---------------------------------------------------------------------------

/**
 * Run a single read-only SELECT against the `properties` view for `county`.
 * The query is validated by {@link validateSelectQuery} and wrapped so the row
 * cap is always enforced regardless of any LIMIT the caller wrote.
 */
export async function runPropertyQuery(
  county: string,
  sql: string,
  limit: number = DEFAULT_ROW_LIMIT,
  signal?: AbortSignal,
): Promise<PropertyQueryResult> {
  return runDatasetQuery(PROPERTY_DATASET, county, sql, limit, signal);
}

/**
 * Run a TRUSTED, internal read-only query against a county's `properties` view.
 * Values must be bound as positional `$1…$n` parameters.
 */
export async function runInternalPropertyQuery(
  county: string | undefined,
  sql: string,
  params: DuckDBValue[] = [],
): Promise<Array<Record<string, Json>>> {
  return runInternalDatasetQuery(PROPERTY_DATASET, county, sql, params);
}

/**
 * Return the column names and DuckDB types of the `properties` view for the
 * given county (via DESCRIBE), reflecting the real Parquet schema.
 */
export async function getPropertyColumns(
  county: string,
  signal?: AbortSignal,
): Promise<PropertyColumn[]> {
  return getDatasetColumns(PROPERTY_DATASET, county, signal);
}

// ---------------------------------------------------------------------------
// PERMIT dataset — query API (parallel surface).
// ---------------------------------------------------------------------------

/**
 * Run a single read-only SELECT against the `permits` view for `county` (one row
 * per building permit). Same validation/capping as {@link runPropertyQuery}.
 */
export async function runPermitQuery(
  county: string,
  sql: string,
  limit: number = DEFAULT_ROW_LIMIT,
): Promise<PropertyQueryResult> {
  return runDatasetQuery(PERMIT_DATASET, county, sql, limit);
}

/**
 * Run a TRUSTED, internal read-only query against a county's `permits` view.
 * Values must be bound as positional `$1…$n` parameters.
 */
export async function runInternalPermitQuery(
  county: string | undefined,
  sql: string,
  params: DuckDBValue[] = [],
): Promise<Array<Record<string, Json>>> {
  return runInternalDatasetQuery(PERMIT_DATASET, county, sql, params);
}

/**
 * Return the column names and DuckDB types of the `permits` view for the given
 * county (via DESCRIBE), reflecting the real Parquet schema.
 */
export async function getPermitColumns(
  county: string,
): Promise<PropertyColumn[]> {
  return getDatasetColumns(PERMIT_DATASET, county);
}

// ---------------------------------------------------------------------------
// CORPORATE dataset — query API.
// ---------------------------------------------------------------------------

/**
 * Run one capped, read-only SELECT/CTE over the exact `corporations` view.
 *
 * @param county - Explicit allowlisted county.
 * @param sql - Caller SQL restricted to the public corporations view.
 * @param limit - Requested row cap, clamped to the global hard maximum.
 * @returns JSON-safe rows containing only approved public columns.
 */
export async function runCorporateQuery(
  county: string,
  sql: string,
  limit: number = DEFAULT_ROW_LIMIT,
): Promise<PropertyQueryResult> {
  return runDatasetQuery(CORPORATE_DATASET, county, sql, limit);
}

/**
 * Return the exact validated DuckDB schema of the `corporations` view.
 *
 * @param county - Explicit allowlisted county.
 * @returns Ordered allowlisted columns and DuckDB types.
 */
export async function getCorporateColumns(
  county: string,
): Promise<PropertyColumn[]> {
  return getDatasetColumns(CORPORATE_DATASET, county);
}
