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
        "Paginated discovery of properties in the Oracle open-data manifest. Returns slim entries (propertyId, parcelIdentifier, cid, county, fileSizeBytes). Use getOracleProperty to fetch full consolidated data for a specific entry.",
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
      },
    },
    async (args: {
      parcelIdentifier?: string;
      propertyId?: string;
      cid?: string;
    }) => {
      return getOraclePropertyHandler(args);
    },
  );

  server.registerTool(
    "getOracleDatasetInfo",
    {
      title: "Get Oracle open-data dataset info",
      description:
        "Returns dataset-level provenance and freshness metadata: county, propertyCount, exportedAt, schemaVersion, totalBytes, and the manifest CID.",
      inputSchema: {},
    },
    async () => {
      return getOracleDatasetInfoHandler();
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
}
