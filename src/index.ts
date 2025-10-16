import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { logger } from "./logger.ts";
import { getConfig } from "./config.ts";
import { listClassesByDataGroupHandler } from "./tools/dataGroups.ts";
import { listPropertiesByClassNameHandler } from "./tools/classes.ts";
import { setServerInstance } from "./lib/serverRef.ts";

const getServer = () => {
  const config = getConfig();
  const server = new McpServer(
    {
      name: config.SERVER_NAME,
      version: config.SERVER_VERSION,
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

  return server;
};

let serverRef: McpServer | undefined;

async function main() {
  const config = getConfig();

  logger.info("Starting MCP server with stdio transport", {
    serverName: config.SERVER_NAME,
    version: config.SERVER_VERSION,
  });

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
      serverName: config.SERVER_NAME,
      version: config.SERVER_VERSION,
    },
  });

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
    error: error instanceof Error ? error.message : error,
  });
  // Best-effort MCP logging of startup error if connected
  if (serverRef?.isConnected()) {
    void serverRef.sendLoggingMessage({
      level: "error",
      logger: "startup",
      data: {
        message: "Server startup error",
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
  process.exit(1);
});
