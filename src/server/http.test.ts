import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  handleRequest: vi.fn(),
  registerAllTools: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    connect = mocks.connect;
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class {
    handleRequest = mocks.handleRequest;
  },
}));

vi.mock("../tools/registry.ts", () => ({
  registerAllTools: mocks.registerAllTools,
}));

vi.mock("../logger.ts", () => ({
  logger: {
    error: mocks.loggerError,
    info: mocks.loggerInfo,
  },
}));

process.env.MCP_HTTP_STANDALONE = "false";

const { handleHttpRequest } = await import("./http.ts");

function invokeHttpRoute(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: string;
}> {
  return new Promise((resolve) => {
    let status = 200;
    let responseHeaders: Record<string, string> = {};
    let body = "";
    const req = { method, url, headers } as unknown as IncomingMessage;
    const res = {
      headersSent: false,
      writeHead(code: number, hdrs: Record<string, string> = {}) {
        status = code;
        responseHeaders = Object.fromEntries(
          Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v]),
        );
        res.headersSent = true;
        return res;
      },
      end(chunk?: string) {
        if (chunk !== undefined) {
          body += chunk;
        }
        resolve({ status, headers: responseHeaders, body });
      },
    };

    void handleHttpRequest(req, res as unknown as ServerResponse);
  });
}

describe("standalone HTTP MCP route authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handleRequest.mockReset();
    delete process.env.MCP_HTTP_AUTH_TOKEN;
    delete process.env.MCP_HTTP_AUTH_TOKENS;
  });

  afterEach(() => {
    delete process.env.MCP_HTTP_AUTH_TOKEN;
    delete process.env.MCP_HTTP_AUTH_TOKENS;
  });

  it("authenticates plural-only MCP_HTTP_AUTH_TOKENS and rejects missing credentials with 401", async () => {
    process.env.MCP_HTTP_AUTH_TOKENS = "enact-secret, secondary-secret";
    mocks.handleRequest.mockImplementation(
      async (
        _req: IncomingMessage,
        res: {
          writeHead: (code: number, hdrs: Record<string, string>) => unknown;
          end: (chunk: string) => void;
        },
      ) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      },
    );

    const unauthorized = await invokeHttpRoute("POST", "/mcp");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toBe("Bearer");
    expect(mocks.handleRequest).not.toHaveBeenCalled();

    const authorizedBearer = await invokeHttpRoute("POST", "/mcp", {
      authorization: "Bearer enact-secret",
    });
    expect(authorizedBearer.status).toBe(200);

    const authorizedCustom = await invokeHttpRoute("POST", "/mcp", {
      "x-mcp-auth-token": "secondary-secret",
    });
    expect(authorizedCustom.status).toBe(200);
    expect(mocks.handleRequest).toHaveBeenCalledTimes(2);
  });

  it("fails closed when MCP_HTTP_AUTH_TOKENS is malformed while keeping /health public", async () => {
    process.env.MCP_HTTP_AUTH_TOKENS = " , ";

    const mcpResponse = await invokeHttpRoute("POST", "/mcp");
    expect(mcpResponse.status).toBe(401);
    expect(mcpResponse.headers["www-authenticate"]).toBe("Bearer");
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Rejected HTTP MCP request because auth configuration yielded no valid tokens",
    );

    const healthResponse = await invokeHttpRoute("GET", "/health");
    expect(healthResponse.status).toBe(200);
  });
});
