import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  getOracleDatasetInfoHandler,
  getOraclePropertyHandler,
  listOraclePropertiesHandler,
} from "./atlasOpenData.ts";
import {
  findPropertiesInAreaHandler,
  sumPropertyValueInAreaHandler,
} from "./atlasGeo.ts";
import {
  getPropertySchemaByClassNameHandler,
  listPropertiesByClassNameHandler,
} from "./classes.ts";
import { listClassesByDataGroupHandler } from "./dataGroups.ts";
import {
  DEFAULT_ROW_LIMIT,
  getPropertyQuerySchemaHandler,
  MAX_ROW_LIMIT,
  queryPropertiesHandler,
} from "./propertyQuery.ts";
import { listPublishedCountiesHandler } from "./publishedCounties.ts";
import { transformExamplesHandler } from "./transformExamples.ts";

const atlasIdentifier = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u);
const atlasScope = {
  county: z.string().min(1).describe("Atlas county key, e.g. 'lee'."),
  dataGroup: atlasIdentifier.describe("Atlas data-group key, e.g. 'county'."),
};
const bboxSchema = z.object({
  minLat: z.number(),
  minLng: z.number(),
  maxLat: z.number(),
  maxLng: z.number(),
});
const polygonSchema = z
  .array(z.object({ lat: z.number(), lng: z.number() }))
  .min(3);
const areaScope = {
  ...atlasScope,
  table: atlasIdentifier.describe("Atlas table containing coordinates."),
  latitudeColumn: atlasIdentifier.optional(),
  longitudeColumn: atlasIdentifier.optional(),
  parcelColumn: atlasIdentifier.optional(),
  valueColumn: atlasIdentifier.optional(),
};

export function registerAllTools(
  server: McpServer,
  _requestSignal?: AbortSignal,
): void {
  server.registerTool(
    "listClassesByDataGroup",
    {
      title: "List classes by data group",
      description: "List lexicon classes in one Elephant data group.",
      inputSchema: {
        groupName: z.string().min(1),
      },
    },
    async ({ groupName }: { groupName: string }) =>
      listClassesByDataGroupHandler(groupName),
  );

  server.registerTool(
    "listPropertiesByClassName",
    {
      title: "List properties by class",
      description: "List non-deprecated lexicon properties for one class.",
      inputSchema: {
        className: z.string().min(1),
      },
    },
    async ({ className }: { className: string }) =>
      listPropertiesByClassNameHandler(className),
  );

  server.registerTool(
    "getPropertySchema",
    {
      title: "Get property schema",
      description: "Return the lexicon schema for one class property.",
      inputSchema: {
        className: z.string().min(1),
        propertyName: z.string().min(1),
      },
    },
    async ({
      className,
      propertyName,
    }: {
      className: string;
      propertyName: string;
    }) => getPropertySchemaByClassNameHandler(className, propertyName),
  );

  server.registerTool(
    "getVerifiedScriptExamples",
    {
      title: "Get verified script examples",
      description: "Search verified Elephant transform scripts semantically.",
      inputSchema: {
        query: z.string().min(1),
        topK: z.number().int().positive().max(50).optional().default(5),
      },
    },
    async ({ query, topK }: { query: string; topK?: number }) =>
      transformExamplesHandler(query, topK),
  );

  server.registerTool(
    "listPublishedCounties",
    {
      title: "List published Atlas counties",
      description:
        "List counties and data groups from the synchronized Atlas index.",
      inputSchema: {},
    },
    async () => listPublishedCountiesHandler(),
  );

  server.registerTool(
    "listOracleProperties",
    {
      title: "List Atlas properties",
      description:
        "List property CIDs and roots for one synchronized county/data group.",
      inputSchema: {
        ...atlasScope,
        limit: z.number().int().positive().max(500).optional().default(50),
        offset: z.number().int().min(0).optional().default(0),
      },
    },
    async (args: {
      county: string;
      dataGroup: string;
      limit?: number;
      offset?: number;
    }) => listOraclePropertiesHandler(args),
  );

  server.registerTool(
    "getOracleProperty",
    {
      title: "Get Atlas property",
      description:
        "Reconstruct one property's Atlas roots, class rows, and relationship rows.",
      inputSchema: {
        ...atlasScope,
        propertyCid: z.string().optional(),
        cid: z.string().optional(),
      },
    },
    async (args: {
      county: string;
      dataGroup: string;
      propertyCid?: string;
      cid?: string;
    }) => getOraclePropertyHandler(args),
  );

  server.registerTool(
    "getOracleDatasetInfo",
    {
      title: "Get Atlas dataset info",
      description:
        "Return synchronized table counts and publication provenance.",
      inputSchema: atlasScope,
    },
    async (args: { county: string; dataGroup: string }) =>
      getOracleDatasetInfoHandler(args),
  );

  server.registerTool(
    "queryProperties",
    {
      title: "Query normalized Atlas table",
      description:
        "Run a scoped read-only SELECT over the logical properties relation.",
      inputSchema: {
        ...atlasScope,
        table: atlasIdentifier,
        sql: z.string().min(1),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_ROW_LIMIT)
          .optional()
          .default(DEFAULT_ROW_LIMIT),
      },
    },
    async (args: {
      county: string;
      dataGroup: string;
      table: string;
      sql: string;
      limit?: number;
    }) => queryPropertiesHandler(args),
  );

  server.registerTool(
    "getPropertyQuerySchema",
    {
      title: "Get normalized Atlas query schema",
      description:
        "List available tables or describe one table for queryProperties.",
      inputSchema: {
        ...atlasScope,
        table: atlasIdentifier.optional(),
      },
    },
    async (args: { county: string; dataGroup: string; table?: string }) =>
      getPropertyQuerySchemaHandler(args),
  );

  server.registerTool(
    "findPropertiesInArea",
    {
      title: "Find Atlas properties in an area",
      description: "Find scoped Atlas rows inside a bounding box or polygon.",
      inputSchema: {
        ...areaScope,
        bbox: bboxSchema.optional(),
        polygon: polygonSchema.optional(),
      },
    },
    async (args: Parameters<typeof findPropertiesInAreaHandler>[0]) =>
      findPropertiesInAreaHandler(args),
  );

  server.registerTool(
    "sumPropertyValueInArea",
    {
      title: "Sum Atlas property value in an area",
      description:
        "Sum a selected value column for scoped Atlas rows in an area.",
      inputSchema: {
        ...areaScope,
        bbox: bboxSchema.optional(),
        polygon: polygonSchema.optional(),
      },
    },
    async (args: Parameters<typeof sumPropertyValueInAreaHandler>[0]) =>
      sumPropertyValueInAreaHandler(args),
  );
}
