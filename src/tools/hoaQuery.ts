import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";
import {
  runHoaQuery,
  getHoaColumns,
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
  HOAS_VIEW,
} from "../lib/duckdbQuery.ts";

const DEFAULT_DATASET = "florida-hoa-registry";

const COLUMN_DESCRIPTIONS: Record<string, string> = {
  document_number: "Florida Sunbiz document number (unique legal entity).",
  entity_name: "ACTIVE Sunbiz legal name.",
  association_base: "Normalized association base used for later parcel joins.",
  filing_type_code: "Sunbiz filing type code (for example DOMNP).",
  filing_type: "Human-readable filing type.",
  status: "Sunbiz status. Census rows are ACTIVE only.",
  filed_date: "Sunbiz filed date (YYYY-MM-DD) when present.",
  principal_city: "Principal city from the corporate record.",
  principal_state: "Principal state from the corporate record.",
  principal_zip: "Principal ZIP from the corporate record.",
  matched_marker: "Strict HOA naming phrase that admitted the row.",
  confidence: "high or medium based on the matched marker.",
  source: "sunbiz, or sunbiz+ctmh when a unique CTMH join exists.",
  ctmh_kind: "condominium, cooperative, or timeshare when CTMH joined.",
  ctmh_project_number: "DBPR CTMH project number when joined.",
  ctmh_join_status: "CTMH-to-Sunbiz join status.",
  source_file: "cordata source file name.",
  source_line: "1-based line in the cordata file.",
  archive_sha256: "SHA-256 of the scanned cordata file.",
  quarter: "Sunbiz quarterly extract identifier.",
  schema_version: "Census schema version.",
};

const SAFETY_NOTE =
  "Read-only: pass a single SELECT statement (a leading WITH/CTE is allowed). " +
  "Multiple statements and any mutating or file/extension keyword " +
  "(INSERT/UPDATE/DELETE/COPY/ATTACH/INSTALL/LOAD/PRAGMA/CALL/SET …) are rejected. " +
  `Results are always capped at ${MAX_ROW_LIMIT} rows. This is not Chapter 720 membership.`;

export async function queryHoasHandler(
  args: {
    sql: string;
    dataset?: string;
    limit?: number;
  },
  options: { signal?: AbortSignal } = {},
) {
  const dataset = args.dataset ?? DEFAULT_DATASET;
  try {
    const limit = args.limit ?? DEFAULT_ROW_LIMIT;
    const result = await runHoaQuery(dataset, args.sql, limit, options.signal);
    return createTextResult(result);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        dataset,
      },
      "queryHoas failed",
    );
    return createTextResult({
      error: "Failed to run HOA registry query",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getHoaQuerySchemaHandler(
  args: { dataset?: string } = {},
  options: { signal?: AbortSignal } = {},
) {
  const dataset = args.dataset ?? DEFAULT_DATASET;
  try {
    const columns = await getHoaColumns(dataset, options.signal);
    return createTextResult({
      dataset,
      view: HOAS_VIEW,
      columnCount: columns.length,
      columns: columns.map((column) => ({
        name: column.name,
        type: column.type,
        description: COLUMN_DESCRIPTIONS[column.name] ?? null,
      })),
      nullabilityNote:
        "This table lists likely ACTIVE association entities, not parcels and not Chapter 720 membership.",
      safetyNote: SAFETY_NOTE,
    });
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        dataset,
      },
      "getHoaQuerySchema failed",
    );
    return createTextResult({
      error: "Failed to fetch HOA query schema",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
