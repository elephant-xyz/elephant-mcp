#!/usr/bin/env node
/**
 * HTTP transport entry point for the Elephant MCP server.
 *
 * Uses the MCP SDK's StreamableHTTPServerTransport over a plain Node.js
 * http.createServer so it runs identically on:
 *   - Local Node.js (npm run start:http)
 *   - Nitro node-server preset (node dist/server-http.js)
 *   - AWS Lambda (via Nitro aws-lambda preset wrapping this handler)
 *   - Vercel / Cloudflare (via Nitro presets)
 *
 * Stateless design: sessionIdGenerator is undefined so each POST request
 * is independent — no server-side session state is required. This lets
 * the server run as a serverless function with no persistent process.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import packageJson from "../../package.json";
import { logger } from "../logger.ts";
import { registerAllTools } from "../tools/registry.ts";

const SERVER_NAME =
  typeof packageJson.name === "string" ? packageJson.name : "@elephant-xyz/mcp";
const SERVER_VERSION =
  typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ---------------------------------------------------------------------------
// Request handler — one stateless MCP server + transport per request
// ---------------------------------------------------------------------------

/**
 * Handles a single MCP-over-HTTP request.
 *
 * Per the MCP spec for stateless servers (sessionIdGenerator: undefined),
 * each POST creates a fresh transport bound to a fresh server instance.
 * This is the correct pattern for serverless deployments.
 */
async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { logging: {} } },
  );

  registerAllTools(server);

  const transport = new StreamableHTTPServerTransport({
    // undefined = stateless; no session management required
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}

// ---------------------------------------------------------------------------
// Health check and routing
// ---------------------------------------------------------------------------

function handleHealthCheck(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION }));
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (url === "/health" && method === "GET") {
    handleHealthCheck(req, res);
    return;
  }

  if (url === "/mcp" || url === "/") {
    try {
      await handleMcpRequest(req, res);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Unhandled error in MCP request handler",
      );
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", path: url }));
}

// ---------------------------------------------------------------------------
// Server startup (only when run directly — not when imported by Nitro)
// ---------------------------------------------------------------------------

if (process.env.MCP_HTTP_STANDALONE !== "false") {
  const httpServer = createServer((req, res) => {
    void routeRequest(req, res);
  });

  httpServer.listen(PORT, () => {
    logger.info(
      { port: PORT, serverName: SERVER_NAME, version: SERVER_VERSION },
      "MCP HTTP server listening",
    );
  });

  process.on("SIGTERM", () => {
    logger.info("SIGTERM received, shutting down HTTP server");
    httpServer.close(() => process.exit(0));
  });

  process.on("SIGINT", () => {
    logger.info("SIGINT received, shutting down HTTP server");
    httpServer.close(() => process.exit(0));
  });
}

// Export the handler for Nitro / Lambda wrapping
export { routeRequest as handleHttpRequest };
