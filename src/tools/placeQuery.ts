import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";
import {
  DEFAULT_PLACE_LIMIT,
  MAX_PLACE_OFFSET,
  PLACES_VIEW,
  describePlacesDataset,
  runPlacesQuery,
  type PlaceQueryRequest,
} from "../lib/placeQuery.ts";
import { MAX_ROW_LIMIT } from "../lib/duckdbQuery.ts";

/**
 * `queryPlaces` / `getPlaceQuerySchema` — a constrained, structured query
 * surface over a catalog-authorized county places parquet.
 *
 * Callers never provide SQL or a data URL. The query engine resolves the URL
 * from Oracle's canonical published-county catalog and binds every filter value.
 */

const COLUMN_DESCRIPTIONS: Readonly<Record<string, string>> = {
  gers_id: "Stable Overture Global Entity Reference System (GERS) place id.",
  county_key: "Canonical lowercase Oracle county key, e.g. 'lee'.",
  county_fips: "Five-digit county FIPS code.",
  name_primary: "Primary Overture place/business name.",
  taxonomy_primary:
    "One primary Overture taxonomy label. Use this field for category counts.",
  taxonomy_hierarchy:
    "Full Overture taxonomy path serialized as '/'-delimited segments; use taxonomyHierarchyMember for hierarchy roll-ups.",
  basic_category:
    "Overture basic-category label passed through without an Elephant vocabulary mapping.",
  legacy_category_primary:
    "Deprecated pre-September-2026 Overture primary category, retained only for reconciliation.",
  operating_status:
    "Overture operating status such as open or permanently_closed; NULL means unspecified.",
  confidence: "Overture confidence score when supplied.",
  longitude: "WGS84 longitude of the place point.",
  latitude: "WGS84 latitude of the place point.",
  address_freeform: "Source free-form business address.",
  address_locality: "Address locality/city.",
  address_postcode: "Address postal code.",
  address_region: "Address region/state.",
  address_country: "Address country code.",
  brand_name: "Primary brand name when present.",
  brand_wikidata: "Brand Wikidata identifier when present.",
  is_hosted_service:
    "Advisory flag for a service hosted inside another business/location.",
  hosted_service_rule: "Release-scoped rule that produced is_hosted_service.",
  overture_release: "Pinned Overture release represented by the row.",
  websites:
    "Pipe-delimited public business websites; intentionally omitted from default queryPlaces rows.",
  phones:
    "Pipe-delimited public business phones; intentionally omitted from default queryPlaces rows.",
  emails:
    "Pipe-delimited public business emails; intentionally omitted from default queryPlaces rows.",
};

const QUERY_CONTRACT = {
  modes: {
    rows: "Returns a deterministic page plus totalCount. Default projection omits websites, phones, and emails.",
    count: "Returns totalCount for the complete filtered county dataset.",
    groupByPrimaryCategory:
      "Returns deterministic taxonomy_primary aggregates ordered by placeCount descending, then category ascending.",
  },
  filters: {
    taxonomyPrimary:
      "{ value, match: 'exact' | 'contains' }; use taxonomy_primary for category counts.",
    taxonomyHierarchyMember:
      "Exact case-insensitive membership in the '/'-delimited hierarchy; use for roll-ups such as restaurant anywhere in the path.",
    basicCategory: "{ value, match: 'exact' | 'contains' }.",
    nameContains: "Case-insensitive substring of name_primary.",
    normalizedNameContains:
      "Alphanumeric, case-insensitive substring after normalizing name_primary.",
    locality: "{ value, match: 'exact' | 'contains' } over address_locality.",
    postcode: "Exact address_postcode.",
    operatingStatus:
      "Exact case-insensitive operating_status; NULL is preserved and not treated as open.",
    hostedService:
      "'include' | 'exclude' | 'only'. MCP default is include; Donphan excludes hosted services by default for business/co-location counts unless the user asks otherwise.",
    minConfidence: "Inclusive confidence threshold from 0 through 1.",
  },
  pagination: {
    defaultLimit: DEFAULT_PLACE_LIMIT,
    maxLimit: MAX_ROW_LIMIT,
    maxOffset: MAX_PLACE_OFFSET,
  },
  deterministicSort: {
    rowFields: ["gersId", "name", "taxonomyPrimary", "locality", "confidence"],
    directions: ["asc", "desc"],
    tieBreaker: "gers_id ascending",
  },
} as const;

/**
 * Execute one structured places query and convert it to an MCP text result.
 *
 * @param args - County, mode, bound filters, pagination, and allowlisted sort.
 * @returns MCP result containing rows/count/groups and publication provenance.
 */
export async function queryPlacesHandler(args: PlaceQueryRequest) {
  try {
    return createTextResult(await runPlacesQuery(args));
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        county: args.county,
      },
      "queryPlaces failed",
    );
    return createTextResult({
      error: "Failed to query published places",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Describe one county's published places table and the structured query contract.
 *
 * @param args - Published county key.
 * @returns MCP result with real parquet columns, field descriptions, safety
 * constraints, source URLs, release/licence metadata, and null completeness.
 */
export async function getPlaceQuerySchemaHandler(args: { county: string }) {
  try {
    const { dataset, columns, provenance } = await describePlacesDataset(
      args.county,
    );
    return createTextResult({
      county: dataset.countyKey,
      countyName: dataset.countyName,
      stateCode: dataset.stateCode,
      countyFips: dataset.countyFips,
      available: true,
      view: PLACES_VIEW,
      columnCount: columns.length,
      columns: columns.map((column) => ({
        name: column.name,
        type: column.type,
        description: COLUMN_DESCRIPTIONS[column.name] ?? null,
        defaultProjection: !["websites", "phones", "emails"].includes(
          column.name,
        ),
      })),
      queryContract: QUERY_CONTRACT,
      nullabilityNote:
        "NULL values are preserved. In particular, a NULL operating_status is unspecified, and a NULL expected_count means completionPercent must remain null.",
      safetyNote:
        "Structured read-only queries only: callers cannot submit SQL or URLs. The parquet URL is resolved from Oracle's canonical catalog, restricted to trusted HTTPS IPFS gateways, and results are parameterized, timed out, deterministically sorted, and capped.",
      provenance,
    });
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        county: args.county,
      },
      "getPlaceQuerySchema failed",
    );
    return createTextResult({
      county: args.county,
      available: false,
      error: "Published places are unavailable for this county",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
