import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";
import {
  runPropertyQuery,
  getPropertyColumns,
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
  PROPERTIES_VIEW,
} from "../lib/duckdbQuery.ts";

/**
 * `queryProperties` / `getPropertyQuerySchema` — the general property query
 * surface backed by the per-county DuckDB query table (one row per property).
 *
 * These are the tools the donphan agent uses to answer arbitrary questions with
 * SQL against the stable `properties` view.
 */

/**
 * One-line descriptions for the query-table columns. Keyed by column name so
 * the schema tool can annotate whatever columns DESCRIBE reports for a county.
 */
const COLUMN_DESCRIPTIONS: Record<string, string> = {
  property_id: "Stable property UUID (one per property).",
  property_cid: "IPFS CID of the property's consolidated open-data JSON.",
  request_identifier:
    "Source request/lookup key used when scraping the parcel.",
  parcel_identifier: "County parcel identifier (folio/APN).",
  source_system: "County discriminator, e.g. 'lee_appraiser'.",
  county_name: "Human-readable county name.",
  state_code: "Two-letter state code (e.g. 'FL').",
  address_street: "Street line of the situs address.",
  address_city: "City of the situs address.",
  address_zip: "ZIP/postal code of the situs address.",
  latitude: "Property centroid latitude (decimal degrees).",
  longitude: "Property centroid longitude (decimal degrees).",
  lot_size_acre: "Lot size in acres.",
  lot_area_sqft: "Lot area in square feet.",
  exterior_wall_material: "Primary exterior wall material.",
  roof_covering_material: "Primary roof covering material.",
  property_type: "Structural property type classification.",
  property_usage_type:
    "Use/zoning classification (e.g. residential, commercial).",
  built_year: "Year the primary structure was built.",
  livable_floor_area: "Livable/heated floor area (square feet).",
  total_area: "Total building area (square feet).",
  assessed_value: "Assessed value from the appraiser roll.",
  market_value: "Market (just) value from the appraiser roll.",
  land_value: "Land-only value from the appraiser roll.",
  avm_value: "Automated valuation model estimate.",
  owner_name: "Primary owner name.",
  owners_text: "All owner names concatenated (searchable free text).",
  owner_count: "Number of owners on record.",
  owner_occupied: "Whether the property appears owner-occupied.",
  last_sale_date: "Date of the most recent recorded sale.",
  last_sale_price: "Price of the most recent recorded sale.",
  subdivision: "Subdivision name, when present.",
  has_permits: "Whether any building permits are known for the property.",
  permit_count: "Number of known building permits.",
  has_sunbiz_tenant:
    "Whether a Sunbiz-registered business is linked to the property.",
  has_bbb_contractor:
    "Whether a BBB-listed contractor is linked to the property.",
  hoa_flag: "Whether the property is flagged as being in an HOA.",
};

const NULLABILITY_NOTE =
  "Coverage varies by county — fields such as hoa_flag, exterior_wall_material, " +
  "roof_covering_material, lot_size_acre, and the enrichment flags may be NULL " +
  "where the county's source data does not provide them.";

const SAFETY_NOTE =
  "Read-only: pass a single SELECT statement (a leading WITH/CTE is allowed). " +
  "Multiple statements and any mutating or file/extension keyword " +
  "(INSERT/UPDATE/DELETE/COPY/ATTACH/INSTALL/LOAD/PRAGMA/CALL/SET …) are rejected. " +
  `Results are always capped at ${MAX_ROW_LIMIT} rows.`;

export async function queryPropertiesHandler(args: {
  county: string;
  sql: string;
  limit?: number;
}) {
  try {
    const limit = args.limit ?? DEFAULT_ROW_LIMIT;
    const result = await runPropertyQuery(args.county, args.sql, limit);
    return createTextResult(result);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        county: args.county,
      },
      "queryProperties failed",
    );
    return createTextResult({
      error: "Failed to run property query",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getPropertyQuerySchemaHandler(args: { county: string }) {
  try {
    const columns = await getPropertyColumns(args.county);
    return createTextResult({
      county: args.county,
      view: PROPERTIES_VIEW,
      columnCount: columns.length,
      columns: columns.map((column) => ({
        name: column.name,
        type: column.type,
        description: COLUMN_DESCRIPTIONS[column.name] ?? null,
      })),
      nullabilityNote: NULLABILITY_NOTE,
      safetyNote: SAFETY_NOTE,
    });
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        county: args.county,
      },
      "getPropertyQuerySchema failed",
    );
    return createTextResult({
      error: "Failed to fetch property query schema",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
