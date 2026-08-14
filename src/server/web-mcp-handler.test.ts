import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  handleRequest: vi.fn(),
  registerAllTools: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    connect = mocks.connect;
    close = mocks.close;
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
    warn: mocks.loggerWarn,
  },
}));

import {
  buildHealthResponse,
  handleWebMcpRequest,
  WEB_MCP_TIMEOUT_MS,
} from "./web-mcp-handler.ts";

const AUTH_TOKEN = "test-production-secret";

function authenticatedInput(method = "POST") {
  return {
    method,
    path: "/mcp",
    headers: {
      "x-mcp-auth-token": AUTH_TOKEN,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    parsedBody: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "queryProperties", arguments: {} },
    },
  };
}

describe("web MCP request budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.handleRequest.mockReset();
    process.env.MCP_HTTP_AUTH_TOKEN = AUTH_TOKEN;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.MCP_HTTP_AUTH_TOKEN;
  });

  it("allows a valid response to complete after the old 30-second boundary", async () => {
    mocks.handleRequest.mockImplementation(
      async (
        _request,
        response: {
          writeHead: (
            status: number,
            headers: Record<string, string>,
          ) => unknown;
          end: (body: string) => void;
        },
      ) => {
        setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
        }, 31_000);
      },
    );

    const responsePromise = handleWebMcpRequest(authenticatedInput());
    await vi.advanceTimersByTimeAsync(31_000);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      result: { ok: true },
    });
    expect(mocks.loggerError).not.toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: WEB_MCP_TIMEOUT_MS }),
      expect.any(String),
    );
  });

  it("aborts downstream work at the configured limit", async () => {
    mocks.handleRequest.mockResolvedValue(undefined);

    const responsePromise = handleWebMcpRequest(authenticatedInput());
    await vi.advanceTimersByTimeAsync(WEB_MCP_TIMEOUT_MS);
    const response = await responsePromise;
    const requestSignal = mocks.registerAllTools.mock.calls[0]?.[1] as
      | AbortSignal
      | undefined;

    expect(response.status).toBe(500);
    expect(requestSignal?.aborted).toBe(true);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      {
        method: "POST",
        path: "/mcp",
        timeoutMs: WEB_MCP_TIMEOUT_MS,
      },
      "Web MCP request exceeded its bounded execution budget",
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("keeps unauthorized MCP routes fail-closed without logging tokens", async () => {
    const secretThatMustNotBeLogged = "do-not-log-this-token";
    const response = await handleWebMcpRequest({
      ...authenticatedInput(),
      headers: { authorization: `Bearer ${secretThatMustNotBeLogged}` },
    });

    expect(response.status).toBe(401);
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain(
      secretThatMustNotBeLogged,
    );
    expect(mocks.handleRequest).not.toHaveBeenCalled();
  });

  it("keeps health public when MCP authentication is configured", async () => {
    const response = buildHealthResponse();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it("returns the protocol-permitted 405 for unsupported GET streams", async () => {
    const response = await handleWebMcpRequest(authenticatedInput("GET"));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, DELETE");
    expect(mocks.handleRequest).not.toHaveBeenCalled();
  });

  it("never includes credentials in structured timeout logs", async () => {
    mocks.handleRequest.mockResolvedValue(undefined);

    const responsePromise = handleWebMcpRequest(authenticatedInput());
    await vi.advanceTimersByTimeAsync(WEB_MCP_TIMEOUT_MS);
    await responsePromise;

    const serializedLogs = JSON.stringify([
      ...mocks.loggerError.mock.calls,
      ...mocks.loggerWarn.mock.calls,
    ]);
    expect(serializedLogs).not.toContain(AUTH_TOKEN);
  });
});
