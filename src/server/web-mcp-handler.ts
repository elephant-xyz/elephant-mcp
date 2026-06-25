/**
 * Web-native MCP handler for h3 v2 / Nitro Vercel preset.
 *
 * The Nitro Vercel preset uses the h3 v2 web/fetch runtime where
 * `event.runtime.node.res` is undefined. `fromNodeHandler` therefore
 * throws "Executing Node.js middleware is not supported in this server!".
 *
 * This module synthesises a minimal Node-compatible (req, res) pair from
 * the incoming web Request, drives `StreamableHTTPServerTransport.handleRequest`,
 * collects everything the transport writes to the fake `res`, and resolves a
 * single web `Response` that h3 can return to Vercel.
 *
 * Design constraints:
 *  - Stateless: fresh McpServer + transport per request (sessionIdGenerator: undefined)
 *  - Buffered: all res.write()/res.end() chunks collected in-memory — acceptable
 *    because MCP initialize/tools/list responses are small (< 64 KB).
 *  - No new npm dependencies: uses only node:events and node:stream builtins.
 */

import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import packageJson from "../../package.json";
import { logger } from "../logger.ts";
import { registerAllTools } from "../tools/registry.ts";

const SERVER_NAME =
  typeof packageJson.name === "string" ? packageJson.name : "@elephant-xyz/mcp";
const SERVER_VERSION =
  typeof packageJson.version === "string" ? packageJson.version : "0.0.0";

// ---------------------------------------------------------------------------
// Minimal Node-shim types
// ---------------------------------------------------------------------------

/**
 * The subset of Node IncomingMessage headers that the MCP SDK transport reads.
 * The transport accesses `req.headers` as a plain object with string values.
 */
export type NodeLikeHeaders = Record<string, string | string[] | undefined>;

/**
 * Builds a REAL Node Readable stream that also carries the IncomingMessage
 * properties the MCP SDK transport reads (`method`, `headers`, `url`,
 * `httpVersion`).
 *
 * Why a real stream: on the Vercel web/fetch (h3 v2) runtime a plain object is
 * NOT a Node Readable, so if `StreamableHTTPServerTransport.handleRequest` ever
 * falls through to its `raw-body` reader (which calls `getRawBody(req)`), it
 * throws "argument stream must be a stream". By backing the shim with
 * `Readable.from(...)` the stream path is always satisfied; the parsed body is
 * still passed as the 3rd arg so the transport normally skips reading entirely.
 */
function createNodeLikeRequest(
  method: string,
  headers: NodeLikeHeaders,
  url: string,
  bodyBytes: Buffer,
): IncomingMessage {
  const readable = Readable.from([bodyBytes]) as unknown as IncomingMessage & {
    method: string;
    headers: NodeLikeHeaders;
    url: string;
    httpVersion: string;
  };
  readable.method = method;
  readable.headers = headers as IncomingMessage["headers"];
  readable.url = url;
  readable.httpVersion = "1.1";
  return readable;
}

/**
 * Minimal Node-like response shim.
 * Extends EventEmitter so `res.on('close', ...)` and `res.on('error', ...)` work.
 */
class NodeLikeResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;

  private readonly responseHeaders: Record<string, string | string[]> = {};
  private readonly chunks: Buffer[] = [];
  private resolveEnd!: (value: {
    status: number;
    headers: Record<string, string | string[]>;
    body: Buffer;
  }) => void;
  private rejectEnd!: (reason: unknown) => void;
  /** Guards against double-settling the promise (resolve OR reject, once). */
  private isSettled = false;

  /** Promise that resolves when res.end() is called (or rejects on failure). */
  readonly settled: Promise<{
    status: number;
    headers: Record<string, string | string[]>;
    body: Buffer;
  }>;

  constructor() {
    super();
    this.settled = new Promise((resolve, reject) => {
      this.resolveEnd = resolve;
      this.rejectEnd = reject;
    });
  }

  /**
   * Rejects the settled promise exactly once. Safe to call from a catch block
   * or a safety timeout even if end() already ran — the first settle wins.
   */
  fail(reason: unknown): void {
    if (this.isSettled) return;
    this.isSettled = true;
    this.rejectEnd(reason);
  }

  /** Called by the transport with (status) or (status, headers). Returns `this` for chaining. */
  writeHead(status: number, headers?: Record<string, string | string[]>): this {
    this.statusCode = status;
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        this.responseHeaders[key.toLowerCase()] = value;
      }
    }
    this.headersSent = true;
    return this;
  }

  setHeader(key: string, value: string | string[]): void {
    this.responseHeaders[key.toLowerCase()] = value;
  }

  getHeader(key: string): string | string[] | undefined {
    return this.responseHeaders[key.toLowerCase()];
  }

  removeHeader(key: string): void {
    delete this.responseHeaders[key.toLowerCase()];
  }

  /** Called after writeHead() on GET streams; no-op here since we buffer. */
  flushHeaders(): void {
    this.headersSent = true;
  }

  /** Accumulates a chunk. Returns true (signals the transport that the write succeeded). */
  write(chunk: string | Buffer | Uint8Array): boolean {
    this.chunks.push(toBuffer(chunk));
    return true;
  }

  /** Finalises the response. May receive a final chunk. */
  end(chunk?: string | Buffer | Uint8Array): void {
    if (chunk !== undefined && chunk !== null && chunk !== "") {
      this.chunks.push(toBuffer(chunk));
    }
    if (this.isSettled) return;
    this.isSettled = true;
    const body = Buffer.concat(this.chunks);
    this.resolveEnd({
      status: this.statusCode,
      headers: this.responseHeaders,
      body,
    });
    // Emit 'close' so any transport-internal cleanup runs.
    this.emit("close");
  }
}

function toBuffer(chunk: string | Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(chunk, "utf-8");
}

// ---------------------------------------------------------------------------
// Health response (no MCP server needed)
// ---------------------------------------------------------------------------

export function buildHealthResponse(): Response {
  return new Response(
    JSON.stringify({
      status: "ok",
      server: SERVER_NAME,
      version: SERVER_VERSION,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// MCP request handler
// ---------------------------------------------------------------------------

/** Inputs already extracted from the h3 event by the runtime-agnostic helpers. */
export interface WebMcpRequestInput {
  /** HTTP method, e.g. "POST" (any case — normalised here). */
  method: string;
  /** Request path, e.g. "/mcp". */
  path: string;
  /** Request headers as a plain (already lowercased or mixed) object. */
  headers: NodeLikeHeaders;
  /** Parsed JSON body for POST (undefined for GET/DELETE). */
  parsedBody?: unknown;
}

/**
 * Handles a single MCP request from primitives extracted off the h3 event.
 *
 * The caller (nitro-handler.ts) extracts method/headers/body using h3 helpers
 * (getMethod / getRequestHeaders / readBody) which work uniformly across every
 * Nitro preset — so this function never has to touch the runtime-specific
 * `event.req` shape.
 */
export async function handleWebMcpRequest(
  input: WebMcpRequestInput,
): Promise<Response> {
  const method = input.method.toUpperCase();

  // Lowercase all header keys for the Node shim (transport reads by lc key).
  const nodeHeaders: NodeLikeHeaders = {};
  for (const [key, value] of Object.entries(input.headers)) {
    if (value !== undefined) nodeHeaders[key.toLowerCase()] = value;
  }

  // For POST the parsed body is passed through to the transport as `parsedBody`,
  // so it skips its own `getRawBody(req)` call. The real Readable below is a
  // belt-and-suspenders fallback in case the transport ever reads the stream.
  const parsedBody: unknown = method === "POST" ? input.parsedBody : undefined;

  // Back the request with the raw JSON bytes so the stream path always works.
  const bodyBytes =
    parsedBody !== undefined
      ? Buffer.from(JSON.stringify(parsedBody), "utf-8")
      : Buffer.alloc(0);

  const nodeReq = createNodeLikeRequest(
    method,
    nodeHeaders,
    input.path,
    bodyBytes,
  );

  const nodeRes = new NodeLikeResponse();

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { logging: {} } },
  );

  registerAllTools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  // Safety timeout: if the transport never calls res.end() AND never throws
  // (e.g. it writes headers then hangs), force-settle so the request can never
  // hang forever. Buffered MCP responses complete in well under this window.
  const SETTLE_TIMEOUT_MS = 30_000;
  const timeout = setTimeout(() => {
    nodeRes.fail(
      new Error(
        `Web MCP handler timed out after ${SETTLE_TIMEOUT_MS}ms without a response`,
      ),
    );
  }, SETTLE_TIMEOUT_MS);
  // Don't keep the process/event loop alive solely for this timer.
  if (typeof timeout.unref === "function") timeout.unref();

  try {
    // Drive the transport. ANY throw here — including a throw AFTER headers
    // were written but before res.end() — must reject the settled promise so
    // the `await nodeRes.settled` below can never hang.
    try {
      await server.connect(transport);
      await transport.handleRequest(
        nodeReq,
        nodeRes as unknown as ServerResponse,
        parsedBody,
      );
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Unhandled error in web MCP handler",
      );
      // If nothing was written yet, return a clean 500 directly. Otherwise the
      // response was partially written/aborted — reject settled so we surface a
      // 500 below instead of hanging.
      if (!nodeRes.headersSent) {
        return new Response(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      nodeRes.fail(error);
    }

    // Wait for the transport to finish writing (res.end() resolves, fail() rejects).
    let status: number;
    let rawHeaders: Record<string, string | string[]>;
    let body: Buffer;
    try {
      ({ status, headers: rawHeaders, body } = await nodeRes.settled);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Web MCP response never settled cleanly — returning 500",
      );
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    // Build the web Response headers.
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (Array.isArray(value)) {
        for (const v of value) {
          responseHeaders.append(key, v);
        }
      } else {
        responseHeaders.set(key, value);
      }
    }

    return new Response(body.length > 0 ? body : null, {
      status,
      headers: responseHeaders,
    });
  } finally {
    clearTimeout(timeout);
  }
}
