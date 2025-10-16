import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

let currentServer: McpServer | undefined;

export function setServerInstance(server: McpServer): void {
  currentServer = server;
}

export function getServerInstance(): McpServer | undefined {
  return currentServer;
}
