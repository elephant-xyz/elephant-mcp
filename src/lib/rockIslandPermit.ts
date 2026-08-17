import { normalizeCountyKey } from "./countyIpnsRegistry.ts";

/** County key whose standalone permit publication has a closed public schema. */
export const ROCK_ISLAND_PERMIT_COUNTY_KEY = "rock-island" as const;

/** Stable public IPNS query-table location published for DuckDB range reads. */
export const ROCK_ISLAND_PERMIT_QUERY_TABLE_URL =
  "https://ipfs.filebase.io/ipns/k51qzi5uqu5di42nblo5nuk94aj7af393d9y5vhqxp5dtxikzso0wt14v3p0wa";

/** Ordered public permit columns; additions, removals, reordering, or type drift fail closed. */
export const ROCK_ISLAND_PERMIT_PUBLIC_DUCKDB_SCHEMA = Object.freeze({
  permit_key: "VARCHAR",
  source_system: "VARCHAR",
  source_report_document_id: "VARCHAR",
  source_report_title: "VARCHAR",
  source_report_url: "VARCHAR",
  permit_number: "VARCHAR",
  permit_issue_date: "VARCHAR",
  record_status: "VARCHAR",
  record_type: "VARCHAR",
  city: "VARCHAR",
  is_roof_permit: "BOOLEAN",
});

/** Ordered public field names derived from the exact DuckDB schema contract. */
export const ROCK_ISLAND_PERMIT_PUBLIC_COLUMNS = Object.freeze(
  Object.keys(ROCK_ISLAND_PERMIT_PUBLIC_DUCKDB_SCHEMA),
);

/**
 * Required semantic qualification for every Rock Island permit tool result.
 *
 * This wording prevents consumers from treating a complete harvest of the
 * currently published monthly reports as complete permit lifecycle or
 * countywide coverage.
 */
export const ROCK_ISLAND_PERMIT_SCOPE_NOTE =
  "Rock Island permit coverage contains 47,385 records from supported official issued-permit reports: 24,786 City of Rock Island records from 112 reports (2017-01-03 through 2026-04-30) and 22,599 Moline records from 102 supported reports (2017-01-03 through 2026-06-30). Sixty-one ambiguous, compacted, contradictory, or conflicting Moline reports are excluded. It is not complete permit lifecycle/history or countywide coverage, and excludes addresses, parcels, descriptions, contractors, valuations, contacts, and all property links.";

/**
 * Determine whether permit-specific Rock Island semantics apply.
 *
 * @param county - User-provided county name or slug.
 * @returns Whether the normalized county is Rock Island.
 */
export function isRockIslandPermitCounty(county: string | undefined): boolean {
  return (
    county !== undefined &&
    normalizeCountyKey(county) === ROCK_ISLAND_PERMIT_COUNTY_KEY
  );
}
