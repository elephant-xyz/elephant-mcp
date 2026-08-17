import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";
import {
  runPermitQuery,
  runInternalPermitQuery,
  getPermitColumns,
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
  PERMITS_VIEW,
} from "../lib/duckdbQuery.ts";
import type { Json } from "@duckdb/node-api";
import {
  ROCK_ISLAND_PERMIT_SCOPE_NOTE,
  isRockIslandPermitCounty,
} from "../lib/rockIslandPermit.ts";

/**
 * `queryPermits` / `getPermitQuerySchema` / `getPermitCoverage` — the general
 * permit query surface backed by the per-county DuckDB permit table (one row per
 * building permit).
 *
 * These are the tools the donphan agent uses to answer aggregate permit
 * questions (e.g. "% of roofs older than 15 years") with SQL against the stable
 * `permits` view, and to QUALIFY those answers with the per-source coverage the
 * permit data actually has.
 */

/**
 * One-line descriptions for the permit-table columns. Keyed by column name so
 * the schema tool can annotate whatever columns DESCRIBE reports for a county.
 */
const COLUMN_DESCRIPTIONS: Record<string, string> = {
  permit_key:
    "Stable key derived only from the approved public source and permit number.",
  source_report_document_id:
    "Public City of Rock Island monthly report document identifier.",
  source_report_title:
    "Public title of the City of Rock Island issued-permit monthly report.",
  source_report_url:
    "Public URL of the City of Rock Island issued-permit monthly report.",
  property_improvement_id: "Stable permit UUID (one per building permit).",
  property_id:
    "UUID of the property this permit is matched to (NULL if unmatched).",
  parcel_identifier: "County parcel identifier (folio/APN) the permit is on.",
  permit_number: "The permit number as issued by the source system.",
  improvement_type:
    "Type/category of the improvement (e.g. Roofing, Electrical).",
  improvement_status: "Normalized permit status.",
  improvement_action: "Permit action (e.g. new, renewal, revision).",
  permit_issue_date: "Date the permit was issued (ISO 'YYYY-MM-DD').",
  application_received_date: "Date the application was received (ISO text).",
  final_inspection_date: "Date of the final inspection (ISO text).",
  permit_close_date: "Date the permit was closed (ISO text).",
  completion_date: "Date the work was completed (ISO text).",
  expiration_date: "Date the permit expires (ISO text).",
  opened_date: "Date the permit record was opened (ISO text).",
  source_system: "Permit source system, e.g. 'lee_appraiser' or 'lee_accela'.",
  county_name:
    "Human-readable county name (from the matched parcel; may be NULL).",
  project_description: "Free-text project description.",
  description: "Free-text permit description.",
  estimated_job_value: "Estimated job/construction value (numeric).",
  fee: "Permit fee amount (numeric).",
  record_status: "Status printed in the source issued-permit report.",
  record_type: "Permit type printed in the source issued-permit report.",
  city: "Issuing city label; this does not imply countywide coverage.",
  is_roof_permit:
    "Reviewed boolean classification indicating a roof-related permit type.",
};

const NULLABILITY_NOTE =
  "Coverage varies by source system — date columns (completion_date, " +
  "permit_issue_date, final_inspection_date …) and value columns are frequently " +
  "NULL, especially for permits harvested from portal sources (e.g. accela). " +
  "property_id/parcel_identifier are NULL for permits that never matched an " +
  "appraisal parcel. Use getPermitCoverage to see per-source counts and date " +
  "ranges before drawing aggregate conclusions.";

const COVERAGE_NOTE =
  "Permit data LAGS the appraisal roll and is not uniformly complete across " +
  "sources: appraiser-derived permits carry structured dates, while some " +
  "portal sources (e.g. accela) may have NULL completion/issue dates. Qualify " +
  "any percentage or rate against the per-source counts below rather than " +
  "assuming full coverage.";

const SAFETY_NOTE =
  "Read-only: pass a single SELECT statement (a leading WITH/CTE is allowed). " +
  "Only the 'permits' view and CTEs derived from it may be queried. Multiple " +
  "statements, external table/file functions, other relations, and any mutating " +
  "or file/extension keyword (INSERT/UPDATE/DELETE/COPY/ATTACH/INSTALL/LOAD/PRAGMA/CALL/SET …) are rejected. " +
  `Results are always capped at ${MAX_ROW_LIMIT} rows.`;

/**
 * Return the required Rock Island scope qualification when applicable.
 *
 * @param county - User-provided county name.
 * @returns Explicit source limitation for Rock Island, otherwise undefined.
 */
function getPermitScopeNote(county: string): string | undefined {
  return isRockIslandPermitCounty(county)
    ? ROCK_ISLAND_PERMIT_SCOPE_NOTE
    : undefined;
}

export async function queryPermitsHandler(args: {
  county: string;
  sql: string;
  limit?: number;
}) {
  try {
    const limit = args.limit ?? DEFAULT_ROW_LIMIT;
    const result = await runPermitQuery(args.county, args.sql, limit);
    const scopeNote = getPermitScopeNote(args.county);
    return createTextResult(
      scopeNote === undefined ? result : { ...result, scopeNote },
    );
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        county: args.county,
      },
      "queryPermits failed",
    );
    const scopeNote = getPermitScopeNote(args.county);
    return createTextResult({
      error: "Failed to run permit query",
      details: error instanceof Error ? error.message : String(error),
      ...(scopeNote === undefined ? {} : { scopeNote }),
    });
  }
}

export async function getPermitQuerySchemaHandler(args: { county: string }) {
  try {
    const columns = await getPermitColumns(args.county);
    const scopeNote = getPermitScopeNote(args.county);
    return createTextResult({
      county: args.county,
      view: PERMITS_VIEW,
      columnCount: columns.length,
      columns: columns.map((column) => ({
        name: column.name,
        type: column.type,
        description: COLUMN_DESCRIPTIONS[column.name] ?? null,
      })),
      nullabilityNote:
        scopeNote === undefined
          ? NULLABILITY_NOTE
          : "The published Rock Island permit fields are required in the source contract; no address, parcel, description, contractor, valuation, contact, or property-link columns are published.",
      safetyNote: SAFETY_NOTE,
      ...(scopeNote === undefined ? {} : { scopeNote }),
    });
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        county: args.county,
      },
      "getPermitQuerySchema failed",
    );
    const scopeNote = getPermitScopeNote(args.county);
    return createTextResult({
      error: "Failed to fetch permit query schema",
      details: error instanceof Error ? error.message : String(error),
      ...(scopeNote === undefined ? {} : { scopeNote }),
    });
  }
}

interface PermitCoverageSource {
  readonly source_system: string | null;
  readonly permit_count: number;
  readonly earliest_date: string | null;
  readonly latest_date: string | null;
}

function toCount(value: Json): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toIsoOrNull(value: Json): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * getPermitCoverage — the per-source COVERAGE the donphan agent uses to qualify
 * permit answers. Runs a TRUSTED internal query (no caller SQL) that groups the
 * `permits` view by source_system with counts and completion_date ranges, plus
 * an overall total.
 */
export async function getPermitCoverageHandler(args: { county: string }) {
  try {
    const scopeNote = getPermitScopeNote(args.county);
    const coverageDateColumn =
      scopeNote === undefined ? "completion_date" : "permit_issue_date";
    const rows = (await runInternalPermitQuery(
      args.county,
      `SELECT source_system,
              count(*) AS permit_count,
              min(${coverageDateColumn}) AS earliest_date,
              max(${coverageDateColumn}) AS latest_date
       FROM ${PERMITS_VIEW}
       GROUP BY source_system
       ORDER BY permit_count DESC`,
    )) as Array<Record<string, Json>>;

    const sources: PermitCoverageSource[] = rows.map((row) => ({
      source_system: toIsoOrNull(row.source_system),
      permit_count: toCount(row.permit_count),
      earliest_date: toIsoOrNull(row.earliest_date),
      latest_date: toIsoOrNull(row.latest_date),
    }));

    const totalPermits = sources.reduce((sum, s) => sum + s.permit_count, 0);

    return createTextResult({
      county: args.county,
      view: PERMITS_VIEW,
      sources,
      totalPermits,
      coverageNote:
        scopeNote === undefined
          ? COVERAGE_NOTE
          : "The earliest/latest values are permit issue dates from the currently published City of Rock Island monthly issued-permit reports.",
      ...(scopeNote === undefined ? {} : { scopeNote }),
    });
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        county: args.county,
      },
      "getPermitCoverage failed",
    );
    const scopeNote = getPermitScopeNote(args.county);
    return createTextResult({
      error: "Failed to fetch permit coverage",
      details: error instanceof Error ? error.message : String(error),
      ...(scopeNote === undefined ? {} : { scopeNote }),
    });
  }
}
