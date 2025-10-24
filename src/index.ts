#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import packageJson from "../package.json";
import { logger } from "./logger.ts";
import { listClassesByDataGroupHandler } from "./tools/dataGroups.ts";
import {
  listPropertiesByClassNameHandler,
  getPropertySchemaByClassNameHandler,
} from "./tools/classes.ts";
import { setServerInstance } from "./lib/serverRef.ts";
import path from "path";
import { getDefaultDataDir } from "./lib/paths.ts";
import { initializeDatabase } from "./db/index.ts";
import { setDbInstance } from "./db/connectionRef.ts";
import { transformExamplesHandler } from "./tools/transformExamples.ts";
import { indexVerifiedScripts } from "./lib/verifiedIndexer.ts";

const SERVER_NAME =
  typeof packageJson.name === "string" ? packageJson.name : "@elephant-xyz/mcp";
const SERVER_VERSION =
  typeof packageJson.version === "string" ? packageJson.version : "0.0.0";

const getServer = () => {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        // Enable MCP logging capability so clients can receive server logs
        logging: {},
        prompts: {},
      },
    },
  );

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
        "Lists JSON Schema property names for an Elephant class (excludes source_http_request). Set withTypes=true to include full JSON Schema per property.",
      inputSchema: {
        className: z
          .string()
          .min(1, "className is required")
          .describe("The class name, case-insensitive"),
        withTypes: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, include full JSON Schema for each property (type, enum, pattern, etc.)",
          ),
      },
    },
    async (args: { className: string; withTypes?: boolean }) => {
      return listPropertiesByClassNameHandler(args.className, args.withTypes);
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

  // Load externalized prompt content from markdown files
  const PROMPTS_BASE_DIR = path.join(process.cwd(), "prompts", "create_transform");
  const readPromptText = (fileName: string, fallback: string): string => {
    try {
      const fullPath = path.join(PROMPTS_BASE_DIR, fileName);
      return fs.readFileSync(fullPath, "utf8");
    } catch (error) {
      logger.warn(
        {
          fileName,
          dir: PROMPTS_BASE_DIR,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to read prompt file; using fallback content",
      );
      return fallback;
    }
  };

  server.registerPrompt(
    "generate_transform",
    {
      title: "GenerateTransformScripts",
      description:
        "Multi-step flow to gather inputs and generate data_extractor.js using MCP tools",
    },
    () => ({
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: readPromptText(
              "01_assistant_intro.md",
              "To get started, please provide:\n\n1) Where are the input HTML examples located? (absolute path, URL, or glob)\n2) Which Elephant data group should we map? (case-insensitive name)\n3) Do you have a data dictionary with additional information about possible values and/or enums? If yes, please share its path/URL or paste the relevant details.",
            ),
          },
        },
        {
          role: "assistant",
          content: {
            type: "text",
            text: readPromptText(
              "02_assistant_instructions.md",
              "You are a senior data engineer. Use the available Elephant MCP tools to complete this task.\n\n- Fetch all classes for the specified data group using the 'listClassesByDataGroup' tool.\n- Assume every object defined by the schema is present in the input HTML; attempt to match and extract all of them.\n- Consult examples with the 'getVerifiedScriptExamples' tool when you need patterns for specific mappings.\n- Use only the 'cheerio' library for HTML parsing/manipulation; do not use any other third-party libraries.\n- Be explicit about assumptions and cover all classes discovered.\n\nRequired Output Files\n\nCreate the following files as part of the solution (produce an empty file if a file is not applicable to the chosen schema):\n- data_extractor.js\n- layoutMapping.js\n- ownerMapping.js\n- structureMapping.js\n- utilityMapping.js\n\nOutput Specification\n\nFor each property, generate these files inside the {data_dir} directory:\n- property.json (This is required for the property data extraction)\n- address.json (copy unnormalized_address OR individual address fields from address content; DO NOT extract from HTML)\n- lot.json\n- tax_*.json\n- flood_storm_information.json\n- sales_*.json\n- deed_*.json\n- file_*.json\n- person_*.json or company_*.json (never both; non-applicable type is null)\n- structure.json, utility.json, layout_*.json\n- relationship_sales_person.json and relationship_sales_company.json (according to owner/sales relationships)\n- relationship_deed_file.json and relationship_sales_deed.json (according to deed relationships)",
            ),
          },
        },
        {
          role: "user",
          content: {
            type: "text",
            text: readPromptText(
              "03_user_task.md",
              "After I answer the two questions, generate 'data_extractor.js' that: (1) uses robust HTML parsing, (2) enumerates schema classes from the chosen data group, (3) attempts to extract instances for each class and map properties, and (4) leverages 'getVerifiedScriptExamples' for mapping guidance when needed.",
            ),
          },
        },
      ],
    }),
  );

  return server;
};

let serverRef: McpServer | undefined;

async function main() {
  logger.info("Starting MCP server with stdio transport", {
    serverName: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Ensure the database is initialized before accepting any tool calls
  const dataDir = getDefaultDataDir();
  const dbPath = path.join(dataDir, "db", "elephant-mcp.sqlite");
  const { db } = await initializeDatabase(dbPath);
  setDbInstance(db);

  const server = getServer();
  serverRef = server;
  setServerInstance(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Emit MCP logging message once connected, so clients can see startup
  await server.sendLoggingMessage({
    level: "info",
    logger: "startup",
    data: {
      message: "MCP server started with stdio transport",
      serverName: SERVER_NAME,
      version: SERVER_VERSION,
    },
  });

  // Kick off background indexing. Failures should not block MCP.
  (async () => {
    try {
      const clonePath = path.join(dataDir, "verified-scripts");
      const result = await indexVerifiedScripts(db, {
        clonePath,
        fullRescan: false,
      });

      logger.info(
        {
          processedFiles: result.processedFiles.length,
          savedFunctions: result.savedFunctions,
          dbPath,
          clonePath,
        },
        "Verified scripts indexing completed",
      );
    } catch (error) {
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "Startup indexing failed; continuing without index",
      );
    }
  })();

  // Graceful shutdown handling (emit MCP log before exit)
  process.on("SIGTERM", () => {
    logger.info("SIGTERM received, shutting down gracefully");
    if (server.isConnected()) {
      void server
        .sendLoggingMessage({
          level: "notice",
          logger: "shutdown",
          data: { signal: "SIGTERM" },
        })
        .finally(() => process.exit(0));
    } else {
      process.exit(0);
    }
  });

  process.on("SIGINT", () => {
    logger.info("SIGINT received, shutting down gracefully");
    if (server.isConnected()) {
      void server
        .sendLoggingMessage({
          level: "notice",
          logger: "shutdown",
          data: { signal: "SIGINT" },
        })
        .finally(() => process.exit(0));
    } else {
      process.exit(0);
    }
  });
}

main().catch((error) => {
  logger.error("Server startup error", {
    error: error instanceof Error ? error.message : String(error),
  });
  // Best-effort MCP logging of startup error if connected
  if (serverRef?.isConnected()) {
    void serverRef
      .sendLoggingMessage({
        level: "error",
        logger: "startup",
        data: {
          message: "Server startup error",
          error: error instanceof Error ? error.message : String(error),
        },
      })
      .finally(() => {
        process.exit(1);
      });
  } else {
    process.exit(1);
  }
});
