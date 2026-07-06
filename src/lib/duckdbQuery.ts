import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection, DuckDBValue, Json } from "@duckdb/node-api";
import { logger } from "../logger.ts";
import { normalizeCountyKey } from "./countyIpnsRegistry.ts";

/**
 * Embedded DuckDB query engine over per-county Parquet "query tables".
 *
 * Step 2 of the DuckDB-on-IPFS indexing feature. Each county's flat, one-row-
 * per-record Parquet is exposed to callers as a stable view. An in-process
 * DuckDB reads it directly (local path) or via HTTP range reads (IPFS gateway
 * URL), so the donphan agent can answer arbitrary questions with plain SQL.
 *
 * Two datasets share ALL of this machinery (SQL safety, env resolution,
 * connection caching), differing only in a small {@link DatasetConfig}:
 *   - PROPERTIES: one row per property, view `properties`, env
 *     PROPERTY_QUERY_TABLE_MAP / PROPERTY_QUERY_TABLE /
 *     PROPERTY_QUERY_TABLE_DEFAULT_COUNTY (Lee runs this in prod).
 *   - PERMITS: one row per building permit, view `permits`, env
 *     PERMIT_QUERY_TABLE_MAP / PERMIT_QUERY_TABLE /
 *     PERMIT_QUERY_TABLE_DEFAULT_COUNTY.
 *
 * A <location> is EITHER a local filesystem path OR an http(s) URL.
 *
 * Safety: callers never touch the DuckDB connection directly. Every caller-
 * facing query goes through {@link runPropertyQuery} / {@link runPermitQuery},
 * which accept a SINGLE read-only SELECT statement (see
 * {@link validateSelectQuery}) and always cap the returned rows.
 */

/** The stable view name the property query table is exposed under. */
export const PROPERTIES_VIEW = "properties";

/** The stable view name the permit query table is exposed under. */
export const PERMITS_VIEW = "permits";

/** Default row cap when the caller does not specify one. */
export const DEFAULT_ROW_LIMIT = 100;

/** Hard upper bound on returned rows, so results can't blow the agent context. */
export const MAX_ROW_LIMIT = 1000;

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
  /** Single-location fallback env var (e.g. `PROPERTY_QUERY_TABLE`). */
  readonly singleEnv: string;
  /** Default-county env var for the single location (e.g. `..._DEFAULT_COUNTY`). */
  readonly defaultCountyEnv: string;
  /** This dataset's private connection cache, keyed by countyKey + location. */
  readonly connectionCache: Map<string, Promise<CountyConnection>>;
}

const PROPERTY_DATASET: DatasetConfig = {
  view: PROPERTIES_VIEW,
  mapEnv: "PROPERTY_QUERY_TABLE_MAP",
  singleEnv: "PROPERTY_QUERY_TABLE",
  defaultCountyEnv: "PROPERTY_QUERY_TABLE_DEFAULT_COUNTY",
  connectionCache: new Map<string, Promise<CountyConnection>>(),
};

const PERMIT_DATASET: DatasetConfig = {
  view: PERMITS_VIEW,
  mapEnv: "PERMIT_QUERY_TABLE_MAP",
  singleEnv: "PERMIT_QUERY_TABLE",
  defaultCountyEnv: "PERMIT_QUERY_TABLE_DEFAULT_COUNTY",
  connectionCache: new Map<string, Promise<CountyConnection>>(),
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
  const map = parseDatasetMap(process.env[config.mapEnv], config.mapEnv);
  const single = process.env[config.singleEnv]?.trim() || null;
  const defaultCountyKey = process.env[config.defaultCountyEnv]
    ? normalizeCountyKey(process.env[config.defaultCountyEnv] as string)
    : null;
  const requestedKey = county ? normalizeCountyKey(county) : defaultCountyKey;

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
  const map = parseDatasetMap(process.env[config.mapEnv], config.mapEnv);
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

function isHttpLocation(location: string): boolean {
  return /^https?:\/\//i.test(location);
}

async function openCountyConnection(
  view: string,
  location: string,
): Promise<CountyConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  if (isHttpLocation(location)) {
    // httpfs lets DuckDB range-read a Parquet served from an IPFS gateway.
    await connection.run("INSTALL httpfs");
    await connection.run("LOAD httpfs");
  }

  const escaped = location.replace(/'/g, "''");
  await connection.run(
    `CREATE VIEW ${view} AS SELECT * FROM read_parquet('${escaped}')`,
  );

  logger.info({ view, location }, "Opened DuckDB query table view");
  return { connection, location };
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

  const cacheKey = `${resolution.countyKey ?? "__default__"}::${resolution.location}`;
  let pending = config.connectionCache.get(cacheKey);
  if (pending === undefined) {
    pending = openCountyConnection(config.view, resolution.location);
    config.connectionCache.set(cacheKey, pending);
    // Don't cache a failed open — let the next call retry.
    pending.catch(() => config.connectionCache.delete(cacheKey));
  }
  return pending;
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
): Promise<PropertyQueryResult> {
  const validation = validateSelectQuery(sql);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const cappedLimit = Math.max(1, Math.min(limit, MAX_ROW_LIMIT));
  const { connection } = await getCountyConnection(config, county);

  const wrapped = `SELECT * FROM (${validation.sql}) AS _q LIMIT ${cappedLimit}`;
  const reader = await connection.runAndReadAll(wrapped);
  const rows = reader.getRowObjectsJson();

  return {
    county: county ?? null,
    rowCount: rows.length,
    limit: cappedLimit,
    rows,
  };
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
  const { connection } = await getCountyConnection(config, county);
  const reader = await connection.runAndReadAll(sql, params);
  return reader.getRowObjectsJson();
}

export interface PropertyColumn {
  readonly name: string;
  readonly type: string;
}

/** Return the column names and DuckDB types of a dataset's view (generic core). */
async function getDatasetColumns(
  config: DatasetConfig,
  county: string,
): Promise<PropertyColumn[]> {
  const { connection } = await getCountyConnection(config, county);
  const reader = await connection.runAndReadAll(`DESCRIBE ${config.view}`);
  const rows = reader.getRowObjectsJson();

  return rows.map((row) => ({
    name: String(row.column_name ?? ""),
    type: String(row.column_type ?? ""),
  }));
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
): Promise<PropertyQueryResult> {
  return runDatasetQuery(PROPERTY_DATASET, county, sql, limit);
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
): Promise<PropertyColumn[]> {
  return getDatasetColumns(PROPERTY_DATASET, county);
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
