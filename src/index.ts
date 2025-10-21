#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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
