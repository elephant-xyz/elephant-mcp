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
import { MAX_ROW_LIMIT, DEFAULT_ROW_LIMIT } from "../lib/duckdbQuery.ts";

/**
 * Registers all MCP tools onto the given server instance.
 *
 * This is the single source of truth for tool definitions — both the stdio
 * entry (src/index.ts) and the HTTP entry (src/server/http.ts) call this
 * function so there is zero duplication between transports.
 */
export function registerAllTools(server: McpServer): void {
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
        "Returns dataset-level metadata for a county: county, propertyCount (live row count when served from the query table), state, and provenance/CID fields on the legacy path. When per-source coverage is configured, also returns datasets[] with, per source (appraisal, permits, sunbiz, bbb), ingestedCount, expectedCount, completionPercent, and first/last loaded timestamps — so callers can qualify partial answers by coverage. For a coverage-only county (no property dataset served) propertyCount is null and propertyDatasetAvailable is false, so callers can distinguish a missing property table from a county with zero properties.",
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
    async (args: { county: string; sql: string; limit?: number }) => {
      return queryPropertiesHandler(args);
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
    async (args: { county: string }) => {
      return getPropertyQuerySchemaHandler(args);
    },
  );

  server.registerTool(
    "queryPermits",
    {
      title: "Query permits (SQL)",
      description:
        "Run a read-only SQL SELECT against a county's flat permit query table (view name 'permits', one row per building permit) backed by embedded DuckDB. Use getPermitQuerySchema first to see available columns and getPermitCoverage to qualify aggregate answers by source. SAFETY: a single SELECT statement only (a leading WITH/CTE is allowed); multiple statements and any mutating or file/extension keyword (INSERT/UPDATE/DELETE/COPY/ATTACH/INSTALL/LOAD/PRAGMA/CALL/SET …) are rejected; results are always capped at " +
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
        "Returns the column list, DuckDB types, and a one-line description of each column of the 'permits' query table for a county, so queryPermits can be written without guessing. Notes that date/value fields are frequently NULL depending on the permit source.",
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
        "Returns per-source-system permit coverage for a county from the 'permits' query table: each source_system with its permit_count and completion_date range (earliest/latest), plus the overall total. The donphan agent uses this to QUALIFY aggregate permit answers (permit data lags appraisals and some sources may have NULL dates).",
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
}
