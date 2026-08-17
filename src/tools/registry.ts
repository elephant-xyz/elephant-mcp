import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listClassesByDataGroupHandler } from "./dataGroups.ts";
import {
  listPropertiesByClassNameHandler,
  getPropertySchemaByClassNameHandler,
} from "./classes.ts";
import { transformExamplesHandler } from "./transformExamples.ts";
import {
  listOraclePropertiesHandler,
  getOraclePropertyHandler,
  getOracleDatasetInfoHandler,
} from "./oracleOpenData.ts";
import { getPropertyPermitsHandler } from "./permits.ts";
import {
  findPropertiesInAreaHandler,
  sumPropertyValueInAreaHandler,
} from "./oracleGeo.ts";
import {
  queryPropertiesHandler,
  getPropertyQuerySchemaHandler,
} from "./propertyQuery.ts";
import {
  queryPermitsHandler,
  getPermitQuerySchemaHandler,
  getPermitCoverageHandler,
} from "./permitQuery.ts";
import {
  queryCorporationsHandler,
  getCorporateQuerySchemaHandler,
} from "./corporateQuery.ts";
import {
  queryPlacesHandler,
  getPlaceQuerySchemaHandler,
} from "./placeQuery.ts";
import { listPublishedCountiesHandler } from "./publishedCounties.ts";
import { MAX_ROW_LIMIT, DEFAULT_ROW_LIMIT } from "../lib/duckdbQuery.ts";
import { ROCK_ISLAND_PERMIT_SCOPE_NOTE } from "../lib/rockIslandPermit.ts";
import {
  DEFAULT_PLACE_LIMIT,
  MAX_PLACE_OFFSET,
  type PlaceQueryRequest,
} from "../lib/placeQuery.ts";

/**
 * Registers all MCP tools onto the given server instance.
 *
 * This is the single source of truth for tool definitions — both the stdio
 * entry (src/index.ts) and the HTTP entry (src/server/http.ts) call this
 * function so there is zero duplication between transports.
 */
export function registerAllTools(
  server: McpServer,
  requestSignal?: AbortSignal,
): void {
  server.registerTool(
    "listClassesByDataGroup",
    {
      title: "List classes by data group",
      description:
        "List classes for an Elephant data group with names and descriptions",
      inputSchema: {
        groupName: z
          .string()
          .min(1, "groupName is required")
          .describe("The data group name, case-insensitive"),
      },
    },
    async (args: { groupName: string }) => {
      return listClassesByDataGroupHandler(args.groupName);
    },
  );

  server.registerTool(
    "listPropertiesByClassName",
    {
      title: "List properties by class name",
      description:
        "Lists JSON Schema property names for an Elephant class (excludes source_http_request)",
      inputSchema: {
        className: z
          .string()
          .min(1, "className is required")
          .describe("The class name, case-insensitive"),
      },
    },
    async (args: { className: string }) => {
      return listPropertiesByClassNameHandler(args.className);
    },
  );

  server.registerTool(
    "getPropertySchema",
    {
      title: "Get property schema by class and property",
      description: "Returns the full JSON Schema object for a class property",
      inputSchema: {
        className: z
          .string()
          .min(1, "className is required")
          .describe("Class name, case-insensitive"),
        propertyName: z
          .string()
          .min(1, "propertyName is required")
          .describe("Property name, case-insensitive"),
      },
    },
    async (args: { className: string; propertyName: string }) => {
      return getPropertySchemaByClassNameHandler(
        args.className,
        args.propertyName,
      );
    },
  );

  server.registerTool(
    "getVerifiedScriptExamples",
    {
      title: "Get verified script examples",
      description:
        "Get most relevant working examples of the code, that maps data to the Elephant schema",
      inputSchema: {
        query: z
          .string()
          .min(1, "text is required")
          .describe(
            "Description of the example meaning. Wll be used to search for similar examples.",
          ),
        topK: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .default(5)
          .describe("Number of results (default 5)"),
      },
    },
    async (args: { query: string; topK?: number }) => {
      return transformExamplesHandler(args.query, args.topK);
    },
  );

  server.registerTool(
    "listPublishedCounties",
    {
      title: "List published Oracle counties",
      description:
        "Returns every county in Oracle's canonical published-county catalog, including stable county keys, state codes, public query/coverage/permit URLs, nullable placesTableUrl, update timestamps, and a catalog revision. Use this tool to discover newly published counties and places availability instead of maintaining a hard-coded list.",
      inputSchema: {},
    },
    async () => listPublishedCountiesHandler(),
  );

  server.registerTool(
    "listOracleProperties",
    {
      title: "List Oracle open-data properties",
      description:
        "Paginated discovery of properties for a county. Returns slim entries (propertyId, parcelIdentifier, cid, county, fileSizeBytes) plus summary fields (address, marketValue, ownerName) when served from the query table. Use getOracleProperty to fetch full consolidated data for a specific entry.",
      inputSchema: {
        county: z
          .string()
          .optional()
          .describe("Filter by county name (case-insensitive)"),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .default(50)
          .describe("Number of results to return (default 50, max 500)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe("Zero-based offset for pagination (default 0)"),
      },
    },
    async (args: { county?: string; limit?: number; offset?: number }) => {
      return listOraclePropertiesHandler(args);
    },
  );

  server.registerTool(
    "getOracleProperty",
    {
      title: "Get Oracle open-data property",
      description:
        "Fetch the full consolidated property JSON (appraisal, permits, Sunbiz, BBB) from IPFS. Provide exactly one of parcelIdentifier, propertyId, or cid.",
      inputSchema: {
        parcelIdentifier: z
          .string()
          .optional()
          .describe(
            "The property parcel identifier (digits) — looked up in the manifest to resolve its IPFS CID",
          ),
        propertyId: z
          .string()
          .optional()
          .describe(
            "The property UUID — looked up in the manifest to resolve its IPFS CID",
          ),
        cid: z
          .string()
          .optional()
          .describe("IPFS CID for the consolidated property JSON"),
        county: z
          .string()
          .optional()
          .describe(
            "County to look up the parcel/property in (case-insensitive). Selects which county's open data to read when the deployment serves multiple counties.",
          ),
      },
    },
    async (args: {
      parcelIdentifier?: string;
      propertyId?: string;
      cid?: string;
      county?: string;
    }) => {
      return getOraclePropertyHandler(args);
    },
  );

  server.registerTool(
    "getOracleDatasetInfo",
    {
      title: "Get Oracle open-data dataset info",
      description:
        "Returns dataset-level metadata for a county: county, propertyCount, state, and provenance/CID fields on the open-property path. When per-source coverage is configured, also returns datasets[] for appraisal, permits, corporate registration, BBB, and other published sources. Corporate county scope means registered-agent office county; it is not business operating location evidence and does not establish tenancy, occupancy, ownership, or property association/linkage. For a coverage-only county propertyCount is null and propertyDatasetAvailable is false.",
      inputSchema: {
        county: z
          .string()
          .optional()
          .describe(
            "County to report dataset info for (case-insensitive). Selects which county's open data to read when the deployment serves multiple counties.",
          ),
      },
    },
    async (args: { county?: string }) => {
      return getOracleDatasetInfoHandler(args);
    },
  );

  server.registerTool(
    "getPropertyPermits",
    {
      title: "Get property permits (on-demand)",
      description:
        "Fetch permit records for a property by parcel ID. Returns cached permits immediately if available. If not cached, enqueues a harvest job (reuses the permit-harvest Lambda) and returns a status indicating the harvest is in progress — poll again after ~90 seconds. Permits are cached to IPFS after harvest completes.",
      inputSchema: {
        parcelId: z
          .string()
          .min(1, "parcelId is required")
          .describe(
            "The property parcel identifier (digits, e.g. '1234567890000')",
          ),
        countyFips: z
          .string()
          .optional()
          .default("12071")
          .describe("County FIPS code (default: 12071 = Lee County FL)"),
      },
    },
    async (args: { parcelId: string; countyFips?: string }) => {
      return getPropertyPermitsHandler(args);
    },
  );

  const bboxSchema = z
    .object({
      minLat: z.number().describe("Minimum latitude (south edge)"),
      minLng: z.number().describe("Minimum longitude (west edge)"),
      maxLat: z.number().describe("Maximum latitude (north edge)"),
      maxLng: z.number().describe("Maximum longitude (east edge)"),
    })
    .describe("User-supplied bounding box of coordinates");

  const polygonSchema = z
    .array(
      z.object({
        lat: z.number().describe("Vertex latitude"),
        lng: z.number().describe("Vertex longitude"),
      }),
    )
    .min(3, "A polygon needs at least 3 vertices")
    .describe("User-supplied polygon ring of coordinates");

  const areaCountySchema = z
    .string()
    .optional()
    .describe(
      "County whose data to read (case-insensitive). Optional: when the deployment serves a single/default county it is inferred; otherwise names which county's query table to search.",
    );

  server.registerTool(
    "findPropertiesInArea",
    {
      title: "Find properties in an area",
      description:
        "Returns the set of properties whose centroid (latitude/longitude) falls inside a user-supplied bounding box or polygon. Provide exactly one of bbox or polygon. Reads the per-county property query table (falls back to the derived geo index); no NOAA/FEMA geometry is used.",
      inputSchema: {
        bbox: bboxSchema.optional(),
        polygon: polygonSchema.optional(),
        county: areaCountySchema,
      },
    },
    async (args: {
      bbox?: { minLat: number; minLng: number; maxLat: number; maxLng: number };
      polygon?: Array<{ lat: number; lng: number }>;
      county?: string;
    }) => {
      return findPropertiesInAreaHandler(args);
    },
  );

  server.registerTool(
    "sumPropertyValueInArea",
    {
      title: "Sum property value in an area",
      description:
        "Returns the exact sum of avm_value over the properties whose centroid falls inside a user-supplied bounding box or polygon, plus the in-area count. Null valuations are treated as 0. Provide exactly one of bbox or polygon. Reads the per-county property query table (falls back to the derived geo index).",
      inputSchema: {
        bbox: bboxSchema.optional(),
        polygon: polygonSchema.optional(),
        county: areaCountySchema,
      },
    },
    async (args: {
      bbox?: { minLat: number; minLng: number; maxLat: number; maxLng: number };
      polygon?: Array<{ lat: number; lng: number }>;
      county?: string;
    }) => {
      return sumPropertyValueInAreaHandler(args);
    },
  );

  server.registerTool(
    "queryProperties",
    {
      title: "Query properties (SQL)",
      description:
        "Run a read-only SQL SELECT against a county's flat property query table (view name 'properties', one row per property) backed by embedded DuckDB. Use getPropertyQuerySchema first to see available columns. SAFETY: a single SELECT statement only (a leading WITH/CTE is allowed); multiple statements and any mutating or file/extension keyword (INSERT/UPDATE/DELETE/COPY/ATTACH/INSTALL/LOAD/PRAGMA/CALL/SET …) are rejected; results are always capped at " +
        `${MAX_ROW_LIMIT} rows.`,
      inputSchema: {
        county: z
          .string()
          .min(1, "county is required")
          .describe("County to query (case-insensitive), e.g. 'Lee'."),
        sql: z
          .string()
          .min(1, "sql is required")
          .describe(
            "A single read-only SELECT statement over the 'properties' view.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_ROW_LIMIT)
          .optional()
          .default(DEFAULT_ROW_LIMIT)
          .describe(
            `Max rows to return (default ${DEFAULT_ROW_LIMIT}, max ${MAX_ROW_LIMIT}). Always enforced.`,
          ),
      },
    },
    async (
      args: { county: string; sql: string; limit?: number },
      { signal },
    ) => {
      return queryPropertiesHandler(args, {
        signal:
          requestSignal === undefined
            ? signal
            : AbortSignal.any([signal, requestSignal]),
      });
    },
  );

  server.registerTool(
    "getPropertyQuerySchema",
    {
      title: "Get property query schema",
      description:
        "Returns the column list, DuckDB types, and a one-line description of each column of the 'properties' query table for a county, so queryProperties can be written without guessing. Notes that some coverage-dependent fields may be NULL.",
      inputSchema: {
        county: z
          .string()
          .min(1, "county is required")
          .describe("County to describe (case-insensitive), e.g. 'Lee'."),
      },
    },
    async (args: { county: string }, { signal }) => {
      return getPropertyQuerySchemaHandler(args, {
        signal:
          requestSignal === undefined
            ? signal
            : AbortSignal.any([signal, requestSignal]),
      });
    },
  );

  const placeTextFilterSchema = z
    .object({
      value: z
        .string()
        .trim()
        .min(1, "filter value is required")
        .max(200, "filter value is too long"),
      match: z
        .enum(["exact", "contains"])
        .optional()
        .default("exact")
        .describe("Exact or case-insensitive substring match."),
    })
    .strict();

  const placeFiltersSchema = z
    .object({
      taxonomyPrimary: placeTextFilterSchema
        .optional()
        .describe(
          "Filter the one primary taxonomy label. Prefer exact for counts.",
        ),
      taxonomyHierarchyMember: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Exact case-insensitive segment membership in the '/'-delimited taxonomy hierarchy (roll-up filter).",
        ),
      basicCategory: placeTextFilterSchema.optional(),
      nameContains: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("Case-insensitive substring of the primary place name."),
      normalizedNameContains: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Substring after lowercasing and removing punctuation from the primary name.",
        ),
      locality: placeTextFilterSchema
        .optional()
        .describe("Exact or contains filter over address locality/city."),
      postcode: z
        .string()
        .trim()
        .min(1)
        .max(20)
        .optional()
        .describe("Exact postal code."),
      operatingStatus: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe("Exact operating status such as open or permanently_closed."),
      hostedService: z
        .enum(["include", "exclude", "only"])
        .optional()
        .default("include")
        .describe(
          "Include all rows (default), exclude advisory hosted services, or return only hosted services.",
        ),
      minConfidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Inclusive minimum Overture confidence score."),
    })
    .strict();

  server.registerTool(
    "queryPlaces",
    {
      title: "Query published Overture places",
      description:
        "Run a structured read-only query over a county's catalog-authorized Overture places parquet. Supports exact/contains category filters, '/'-hierarchy roll-ups, name/locality/postcode/status/confidence filters, hosted-service include/exclude/only, deterministic row pages with totalCount, count-only mode, and grouped taxonomy_primary aggregates. Call getPlaceQuerySchema first. Callers cannot provide SQL or data URLs; results are capped at " +
        `${MAX_ROW_LIMIT}.`,
      inputSchema: {
        county: z
          .string()
          .trim()
          .min(1, "county is required")
          .max(64)
          .regex(
            /^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/,
            "county must be a name or lowercase hyphenated key",
          )
          .describe("Published county key/name, e.g. 'lee' or 'Lee'."),
        mode: z
          .enum(["rows", "count", "groupByPrimaryCategory"])
          .optional()
          .default("rows")
          .describe("Rows page, filtered count, or primary-category groups."),
        filters: placeFiltersSchema.optional().default({}),
        sortBy: z
          .enum(["gersId", "name", "taxonomyPrimary", "locality", "confidence"])
          .optional()
          .default("gersId")
          .describe("Allowlisted row sort field; ignored for grouped mode."),
        sortDirection: z
          .enum(["asc", "desc"])
          .optional()
          .default("asc")
          .describe("Row sort direction; ignored for grouped mode."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_ROW_LIMIT)
          .optional()
          .default(DEFAULT_PLACE_LIMIT)
          .describe(
            `Rows/groups per page (default ${DEFAULT_PLACE_LIMIT}, max ${MAX_ROW_LIMIT}).`,
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .max(MAX_PLACE_OFFSET)
          .optional()
          .default(0)
          .describe(
            `Zero-based page offset (default 0, max ${MAX_PLACE_OFFSET}).`,
          ),
      },
    },
    async (args: PlaceQueryRequest) => queryPlacesHandler(args),
  );

  server.registerTool(
    "getPlaceQuerySchema",
    {
      title: "Get published places query schema",
      description:
        "Returns the real published places parquet columns, field descriptions, structured queryPlaces contract, safety limits, Overture release/provenance and licence-gate metadata, and honest null completion semantics for a county.",
      inputSchema: {
        county: z
          .string()
          .trim()
          .min(1, "county is required")
          .max(64)
          .regex(
            /^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/,
            "county must be a name or lowercase hyphenated key",
          )
          .describe("Published county key/name, e.g. 'lee' or 'Lee'."),
      },
    },
    async (args: { county: string }) => getPlaceQuerySchemaHandler(args),
  );

  server.registerTool(
    "queryPermits",
    {
      title: "Query permits (SQL)",
      description:
        "Run a read-only SQL SELECT against a county's flat permit query table (view name 'permits', one row per building permit) backed by embedded DuckDB. Use getPermitQuerySchema first to see available columns and getPermitCoverage to qualify aggregate answers by source. SAFETY: a single SELECT statement only (a leading WITH/CTE is allowed); multiple statements and any mutating or file/extension keyword (INSERT/UPDATE/DELETE/COPY/ATTACH/INSTALL/LOAD/PRAGMA/CALL/SET …) are rejected; results are always capped at " +
        `${MAX_ROW_LIMIT} rows. For Rock Island: ${ROCK_ISLAND_PERMIT_SCOPE_NOTE}`,
      inputSchema: {
        county: z
          .string()
          .min(1, "county is required")
          .describe("County to query (case-insensitive), e.g. 'Lee'."),
        sql: z
          .string()
          .min(1, "sql is required")
          .describe(
            "A single read-only SELECT statement over the 'permits' view.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_ROW_LIMIT)
          .optional()
          .default(DEFAULT_ROW_LIMIT)
          .describe(
            `Max rows to return (default ${DEFAULT_ROW_LIMIT}, max ${MAX_ROW_LIMIT}). Always enforced.`,
          ),
      },
    },
    async (args: { county: string; sql: string; limit?: number }) => {
      return queryPermitsHandler(args);
    },
  );

  server.registerTool(
    "getPermitQuerySchema",
    {
      title: "Get permit query schema",
      description:
        "Returns the column list, DuckDB types, and a one-line description of each column of the 'permits' query table for a county, so queryPermits can be written without guessing. Notes that date/value fields are frequently NULL depending on the permit source. For Rock Island: " +
        ROCK_ISLAND_PERMIT_SCOPE_NOTE,
      inputSchema: {
        county: z
          .string()
          .min(1, "county is required")
          .describe("County to describe (case-insensitive), e.g. 'Lee'."),
      },
    },
    async (args: { county: string }) => {
      return getPermitQuerySchemaHandler(args);
    },
  );

  server.registerTool(
    "getPermitCoverage",
    {
      title: "Get permit coverage by source",
      description:
        "Returns per-source-system permit coverage for a county from the 'permits' query table: each source_system with its permit_count and relevant date range (earliest/latest), plus the overall total. The donphan agent uses this to QUALIFY aggregate permit answers. For Rock Island the range is based on permit_issue_date: " +
        ROCK_ISLAND_PERMIT_SCOPE_NOTE,
      inputSchema: {
        county: z
          .string()
          .min(1, "county is required")
          .describe(
            "County to report permit coverage for (case-insensitive), e.g. 'Lee'.",
          ),
      },
    },
    async (args: { county: string }) => {
      return getPermitCoverageHandler(args);
    },
  );

  server.registerTool(
    "queryCorporations",
    {
      title: "Query corporate registrations (SQL)",
      description:
        "Run one read-only SQL SELECT or leading WITH/CTE against the exact privacy-approved 'corporations' view for an allowlisted county. County scope means registered-agent office county; it is not a business operating location and does not establish tenancy, occupancy, ownership, or any property association/linkage. Use getCorporateQuerySchema first. Other relations, external table functions, multiple statements, and mutating/file/extension operations are rejected; results are capped at " +
        `${MAX_ROW_LIMIT} rows.`,
      inputSchema: {
        county: z
          .string()
          .min(1, "county is required")
          .describe(
            "Registered-agent office county to query (case-insensitive); currently Rock Island.",
          ),
        sql: z
          .string()
          .min(1, "sql is required")
          .describe(
            "One read-only SELECT or leading WITH/CTE over the 'corporations' view.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_ROW_LIMIT)
          .optional()
          .default(DEFAULT_ROW_LIMIT)
          .describe(
            `Max rows to return (default ${DEFAULT_ROW_LIMIT}, max ${MAX_ROW_LIMIT}). Always enforced.`,
          ),
      },
    },
    async (args: { county: string; sql: string; limit?: number }) => {
      return queryCorporationsHandler(args);
    },
  );

  server.registerTool(
    "getCorporateQuerySchema",
    {
      title: "Get corporate-registration query schema",
      description:
        "Returns the exact allowlisted columns, DuckDB types, mixed-date availability, SQL safety rules, and privacy semantics for the 'corporations' view. County scope means registered-agent office county; it is not a business operating location and does not establish tenancy, occupancy, ownership, or any property association/linkage.",
      inputSchema: {
        county: z
          .string()
          .min(1, "county is required")
          .describe(
            "Registered-agent office county to describe (case-insensitive); currently Rock Island.",
          ),
      },
    },
    async (args: { county: string }) => {
      return getCorporateQuerySchemaHandler(args);
    },
  );
}
