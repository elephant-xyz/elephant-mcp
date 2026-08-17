import {
  CORPORATIONS_VIEW,
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
  getCorporateColumns,
  runCorporateQuery,
} from "../lib/duckdbQuery.ts";
import { CORPORATE_SCOPE_NOTE } from "../lib/corporateManifest.ts";
import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";

/**
 * MCP query surface for the privacy-approved Illinois organization registry.
 *
 * The underlying Parquet contains organization-only fields. It deliberately
 * excludes people, addresses, contacts, source payloads, hashes, and property
 * relationships. County routing is registered-agent-office scope only.
 */

/** Field-level descriptions for the exact public corporate allowlist. */
const COLUMN_DESCRIPTIONS: Readonly<Record<string, string>> = {
  illinois_file_number:
    "Public Illinois Secretary of State organization file number.",
  legal_company_name: "Public legal organization name.",
  entity_type_code: "Illinois SOS entity-type code, when available.",
  entity_type: "Illinois SOS entity-type label, when available.",
  entity_status_code: "Illinois SOS entity-status code, when available.",
  entity_status: "Illinois SOS entity-status label, when available.",
  incorporation_date: "Available incorporation/filing date (YYYY-MM-DD).",
  organization_date:
    "Organization date; NULL in this accepted mixed-date publication.",
  dissolution_date:
    "Dissolution date; NULL in this accepted mixed-date publication.",
  source_system: "Registry source system; fixed to 'illinois_sos'.",
  master_snapshot_date: "Illinois SOS master-component snapshot date.",
  name_snapshot_date: "Illinois SOS name-component snapshot date.",
  agent_snapshot_date: "Illinois SOS agent-component snapshot date.",
  snapshot_consistency:
    "Snapshot consistency label; 'mixed_date' for this publication.",
  statewide_intersection_coverage_percent:
    "Percent of statewide master records retained by the accepted component intersection.",
  county_scope_type:
    "Fixed to 'registered_agent_office_county'; this is not operating-location or property evidence.",
  county_code:
    "Illinois registered-agent office county code used for this publication.",
  county_label:
    "Coarse registered-agent office county label; not a business operating location.",
};

const DATE_NOTE =
  "This is an accepted mixed-date snapshot: master and agent components are dated 2026-07-29, while the name component is dated 2026-07-28. organization_date and dissolution_date are unavailable and remain NULL.";

const SAFETY_NOTE =
  "Read-only: pass one SELECT statement or a leading WITH/CTE over the 'corporations' view. Other relations, external table functions, multiple statements, and mutating/file/extension operations are rejected. " +
  `Results are always capped at ${MAX_ROW_LIMIT} rows.`;

/** Arguments accepted by the corporate SQL handler. */
export interface CorporateQueryArgs {
  /** Explicit county name or slug; currently only Rock Island is allowlisted. */
  readonly county: string;
  /** One read-only SELECT/CTE over the `corporations` view. */
  readonly sql: string;
  /** Optional requested result limit, capped by the engine. */
  readonly limit?: number;
}

/**
 * Run one fail-closed SQL query over safe public corporate rows.
 *
 * @param args - Explicit county, read-only SQL, and optional row limit.
 * @returns MCP text content containing rows or a safe error; every result
 * includes the registered-agent-office county semantics.
 */
export async function queryCorporationsHandler(args: CorporateQueryArgs) {
  if (typeof args.county !== "string" || args.county.trim() === "") {
    return createTextResult({
      error: "A corporate-registration county is required",
      scopeNote: CORPORATE_SCOPE_NOTE,
    });
  }

  try {
    const result = await runCorporateQuery(
      args.county,
      args.sql,
      args.limit ?? DEFAULT_ROW_LIMIT,
    );
    return createTextResult({
      ...result,
      scopeNote: CORPORATE_SCOPE_NOTE,
    });
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        county: args.county,
      },
      "queryCorporations failed",
    );
    return createTextResult({
      error: "Failed to run corporate-registration query",
      details: error instanceof Error ? error.message : String(error),
      scopeNote: CORPORATE_SCOPE_NOTE,
    });
  }
}

/** Arguments accepted by the corporate schema handler. */
export interface CorporateSchemaArgs {
  /** Explicit county name or slug; currently only Rock Island is allowlisted. */
  readonly county: string;
}

/**
 * Describe the exact allowlisted public `corporations` view.
 *
 * @param args - Explicit county to resolve and validate.
 * @returns MCP text content with ordered columns, safety/date notes, and
 * registered-agent-office county semantics.
 */
export async function getCorporateQuerySchemaHandler(
  args: CorporateSchemaArgs,
) {
  if (typeof args.county !== "string" || args.county.trim() === "") {
    return createTextResult({
      error: "A corporate-registration county is required",
      scopeNote: CORPORATE_SCOPE_NOTE,
    });
  }

  try {
    const columns = await getCorporateColumns(args.county);
    return createTextResult({
      county: args.county,
      view: CORPORATIONS_VIEW,
      columnCount: columns.length,
      columns: columns.map((column) => ({
        name: column.name,
        type: column.type,
        description: COLUMN_DESCRIPTIONS[column.name] ?? null,
      })),
      dateNote: DATE_NOTE,
      safetyNote: SAFETY_NOTE,
      scopeNote: CORPORATE_SCOPE_NOTE,
    });
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        county: args.county,
      },
      "getCorporateQuerySchema failed",
    );
    return createTextResult({
      error: "Failed to fetch corporate-registration query schema",
      details: error instanceof Error ? error.message : String(error),
      scopeNote: CORPORATE_SCOPE_NOTE,
    });
  }
}
