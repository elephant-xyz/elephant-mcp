import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection, DuckDBValue, Json } from "@duckdb/node-api";
import { logger } from "../logger.ts";
import { normalizeCountyKey } from "./countyIpnsRegistry.ts";

/**
 * Embedded DuckDB query engine over a per-county Parquet "query table".
 *
 * Step 2 of the DuckDB-on-IPFS indexing feature. Each county's flat, one-row-
 * per-property Parquet is exposed to callers as a stable view named
 * `properties`. An in-process DuckDB reads it directly (local path) or via HTTP
 * range reads (IPFS gateway URL), so the donphan agent can answer arbitrary
 * questions with plain SQL.
 *
 * County → Parquet location is resolved from env vars, mirroring the IPNS-map
 * pattern used by the open-data/geo datasets:
 *   PROPERTY_QUERY_TABLE_MAP  – JSON map {"lee":"<location>", ...}
 *   PROPERTY_QUERY_TABLE      – legacy single-county location (fallback)
 *   PROPERTY_QUERY_TABLE_DEFAULT_COUNTY – county the single location serves
 * A <location> is EITHER a local filesystem path OR an http(s) URL.
 *
 * Safety: callers never touch the DuckDB connection directly. Every query goes
 * through {@link runPropertyQuery}, which accepts a SINGLE read-only SELECT
 * statement (see {@link validateSelectQuery}) and always caps the returned rows.
 */

/** The stable view name every county's query table is exposed under. */
export const PROPERTIES_VIEW = "properties";

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

/**
 * Parse the PROPERTY_QUERY_TABLE_MAP env var (a JSON object of
 * county → Parquet location). Returns an empty map when unset, blank, or
 * malformed — the failure is logged so a bad config is visible without
 * crashing the server. Keys are normalized; blank/non-string values are
 * skipped.
 */
export function parseQueryTableMap(
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
      "Failed to parse PROPERTY_QUERY_TABLE_MAP JSON — ignoring (falling back to single query table)",
    );
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    logger.warn("PROPERTY_QUERY_TABLE_MAP is not a JSON object — ignoring");
    return {};
  }

  const map: Record<string, string> = {};
  for (const [county, location] of Object.entries(parsed)) {
    if (typeof location !== "string" || location.trim() === "") {
      logger.warn(
        { county },
        "Skipping PROPERTY_QUERY_TABLE_MAP entry with a non-string/blank location",
      );
      continue;
    }
    map[normalizeCountyKey(county)] = location.trim();
  }

  return map;
}

/**
 * Resolve the Parquet location to read for the given county.
 *
 * - No map configured (legacy mode): always resolve to the single
 *   PROPERTY_QUERY_TABLE location.
 * - Map configured: county in the map → its location; county equals the
 *   configured default county → the single location; otherwise → not served.
 */
export function resolveQueryTableLocation(
  county: string | undefined,
): QueryTableResolution {
  const map = parseQueryTableMap(process.env.PROPERTY_QUERY_TABLE_MAP);
  const single = process.env.PROPERTY_QUERY_TABLE?.trim() || null;
  const defaultCountyKey = process.env.PROPERTY_QUERY_TABLE_DEFAULT_COUNTY
    ? normalizeCountyKey(process.env.PROPERTY_QUERY_TABLE_DEFAULT_COUNTY)
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
 * Whether this deployment can serve the requested county from a per-county
 * query table (DuckDB over Parquet). The data tools use this as the gate that
 * decides between the query-table PRIMARY path and the legacy sharded/geo-index
 * FALLBACK path.
 */
export function isCountyServedByQueryTable(
  county: string | undefined,
): boolean {
  return resolveQueryTableLocation(county).served;
}

/**
 * Resolve the county a query-table-backed tool should target when the caller
 * did not name one. This keeps the env-minimal story working — a migrated
 * deployment can set only PROPERTY_QUERY_TABLE_MAP with a single county and the
 * countyless geo tools still resolve it. Returns:
 *   - the sole county key when the map has exactly one entry;
 *   - the configured default county otherwise;
 *   - null when neither applies (legacy single-table mode resolves undefined
 *     directly, so null is the correct "no explicit county" signal there).
 */
export function resolveDefaultQueryTableCounty(): string | null {
  const map = parseQueryTableMap(process.env.PROPERTY_QUERY_TABLE_MAP);
  const keys = Object.keys(map);
  if (keys.length === 1) {
    return keys[0] ?? null;
  }
  const defaultCounty = process.env.PROPERTY_QUERY_TABLE_DEFAULT_COUNTY?.trim();
  if (defaultCounty) {
    return normalizeCountyKey(defaultCounty);
  }
  return null;
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

interface CountyConnection {
  readonly connection: DuckDBConnection;
  readonly location: string;
}

// One DuckDB connection per resolved (county → location). The MCP process is
// long-lived, so opening the instance once and reusing the `properties` view
// keeps per-query latency low. Keyed by countyKey + location so a config change
// (or a per-county location) never serves the wrong table.
const connectionCache = new Map<string, Promise<CountyConnection>>();

/** Reset all cached DuckDB connections. Intended for tests. */
export function clearPropertyQueryConnections(): void {
  connectionCache.clear();
}

function isHttpLocation(location: string): boolean {
  return /^https?:\/\//i.test(location);
}

async function openCountyConnection(
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
    `CREATE VIEW ${PROPERTIES_VIEW} AS SELECT * FROM read_parquet('${escaped}')`,
  );

  logger.info({ location }, "Opened DuckDB query table view 'properties'");
  return { connection, location };
}

async function getCountyConnection(
  county: string | undefined,
): Promise<CountyConnection> {
  const resolution = resolveQueryTableLocation(county);
  if (!resolution.served || resolution.location === null) {
    throw new Error(
      county
        ? `County '${county}' is not served by this deployment's property query table.`
        : "No property query table is configured — set PROPERTY_QUERY_TABLE or PROPERTY_QUERY_TABLE_MAP.",
    );
  }

  const cacheKey = `${resolution.countyKey ?? "__default__"}::${resolution.location}`;
  let pending = connectionCache.get(cacheKey);
  if (pending === undefined) {
    pending = openCountyConnection(resolution.location);
    connectionCache.set(cacheKey, pending);
    // Don't cache a failed open — let the next call retry.
    pending.catch(() => connectionCache.delete(cacheKey));
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
 * Run a single read-only SELECT against the `properties` view for `county`.
 * The query is validated by {@link validateSelectQuery} and wrapped so the row
 * cap is always enforced regardless of any LIMIT the caller wrote.
 */
export async function runPropertyQuery(
  county: string,
  sql: string,
  limit: number = DEFAULT_ROW_LIMIT,
): Promise<PropertyQueryResult> {
  const validation = validateSelectQuery(sql);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const cappedLimit = Math.max(1, Math.min(limit, MAX_ROW_LIMIT));
  const { connection } = await getCountyConnection(county);

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
 * Run a TRUSTED, internal read-only query against a county's `properties` view.
 *
 * Unlike {@link runPropertyQuery}, this does NOT run the caller-facing SELECT
 * validator or force a row cap: the SQL here is authored by the data tools
 * themselves (not user input), with all runtime values bound as positional
 * `$1…$n` parameters, so it is safe by construction. It exists so the open-data
 * and geo tools can read the same per-county query table instead of the retired
 * sharded/geo indexes.
 */
export async function runInternalPropertyQuery(
  county: string | undefined,
  sql: string,
  params: DuckDBValue[] = [],
): Promise<Array<Record<string, Json>>> {
  const { connection } = await getCountyConnection(county);
  const reader = await connection.runAndReadAll(sql, params);
  return reader.getRowObjectsJson();
}

export interface PropertyColumn {
  readonly name: string;
  readonly type: string;
}

/**
 * Return the column names and DuckDB types of the `properties` view for the
 * given county (via DESCRIBE), reflecting the real Parquet schema.
 */
export async function getPropertyColumns(
  county: string,
): Promise<PropertyColumn[]> {
  const { connection } = await getCountyConnection(county);
  const reader = await connection.runAndReadAll(`DESCRIBE ${PROPERTIES_VIEW}`);
  const rows = reader.getRowObjectsJson();

  return rows.map((row) => ({
    name: String(row.column_name ?? ""),
    type: String(row.column_type ?? ""),
  }));
}
