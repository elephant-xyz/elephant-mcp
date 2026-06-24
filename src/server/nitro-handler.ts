/**
 * Nitro event handler — web-native h3 v2 bridge to the MCP server.
 *
 * The Nitro Vercel preset uses the h3 v2 web/fetch runtime where
 * `event.runtime.node.res` is undefined. `fromNodeHandler` throws at runtime:
 *   "Executing Node.js middleware is not supported in this server!"
 *
 * This handler is web-native: it extracts method, path, headers and body from
 * the h3 event using h3's runtime-agnostic helpers (getMethod / getRequestURL /
 * getRequestHeaders / readBody) — these work uniformly on the Vercel web/fetch
 * runtime, where the raw `event.req` shape (url, headers, .json()) is NOT a
 * standard web Request — then delegates to `handleWebMcpRequest` /
 * `buildHealthResponse` and returns a web `Response` directly.
 *
 * The Node-compatible (req, res) pair that `StreamableHTTPServerTransport.handleRequest`
 * needs is synthesised inside `web-mcp-handler.ts`, which lives entirely below this
 * boundary and keeps `src/server/http.ts` untouched.
 *
 * Compatibility matrix:
 *   - Nitro vercel preset    → this file (web/fetch runtime)
 *   - Nitro node-server      → src/server/http.ts via a separate entry point
 *   - AWS Lambda / Cloudflare → src/server/http.ts (node-compatible runtimes)
 */
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { defineEventHandler, getMethod } from "h3";
import {
  buildHealthResponse,
  handleWebMcpRequest,
  type NodeLikeHeaders,
} from "./web-mcp-handler.ts";

/**
 * Extracts request headers as a plain object across Nitro presets.
 *
 * On the Vercel preset `event.req.headers` is a plain object (no `.entries()`),
 * so h3's `getRequestHeaders()` throws "event.req.headers.entries is not a
 * function". Prefer the underlying Node IncomingMessage headers (always a plain
 * object) and fall back to whatever shape `event.req.headers` is (web Headers
 * with .forEach, an iterable, or a plain object).
 */
function extractHeaders(event: {
  req: { headers?: unknown };
  runtime?: { node?: { req?: IncomingMessage } };
}): NodeLikeHeaders {
  const out: NodeLikeHeaders = {};
  const nodeHeaders = event.runtime?.node?.req?.headers as
    | IncomingHttpHeaders
    | undefined;
  if (nodeHeaders) {
    for (const [k, v] of Object.entries(nodeHeaders)) {
      if (v !== undefined) out[k.toLowerCase()] = v;
    }
    return out;
  }
  const h = event.req.headers as unknown;
  if (h && typeof (h as Headers).forEach === "function") {
    (h as Headers).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
  } else if (
    h &&
    typeof (h as Iterable<[string, string]>)[Symbol.iterator] === "function"
  ) {
    for (const [key, value] of h as Iterable<[string, string]>) {
      out[key.toLowerCase()] = value;
    }
  } else if (h && typeof h === "object") {
    for (const [key, value] of Object.entries(
      h as Record<string, string | string[] | undefined>,
    )) {
      if (value !== undefined) out[key.toLowerCase()] = value;
    }
  }
  return out;
}

/**
 * Reads the request body as a string across Nitro presets.
 *
 * On the Vercel preset, `event.req` is NOT a srvx web Request — it is the raw
 * Node `http.IncomingMessage` (a Readable stream). It exposes no `.text()` /
 * `.json()` web body methods and no `event.runtime.node.req`, and its stream is
 * still unread when this handler runs. The earlier attempts to read via
 * `event.req.text()` or `event.runtime.node.req` therefore both yielded an
 * EMPTY body, producing the SDK "Parse error / Unexpected end of JSON input".
 *
 * The correct, portable strategy:
 *   1. If `event.req` has web body methods (`.text()`), use them (node-server
 *      / true web-fetch presets).
 *   2. Otherwise if a Node IncomingMessage is reachable — either at
 *      `event.runtime.node.req` or as `event.req` itself (the Vercel case) —
 *      read it directly as a Readable stream.
 */
async function readRequestBodyText(event: {
  req: unknown;
  runtime?: { node?: { req?: IncomingMessage } };
}): Promise<string> {
  const webReq = event.req as { text?: () => Promise<string> };
  if (typeof webReq.text === "function") {
    return await webReq.text();
  }

  // Prefer an explicit runtime node req, else fall back to event.req itself,
  // which on the Vercel preset IS the Node IncomingMessage stream.
  const nodeReq =
    event.runtime?.node?.req ??
    (typeof (event.req as IncomingMessage)?.on === "function"
      ? (event.req as IncomingMessage)
      : undefined);

  if (nodeReq && typeof nodeReq.on === "function") {
    return await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      nodeReq.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      nodeReq.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      nodeReq.on("error", reject);
    });
  }
  return "";
}

export default defineEventHandler(async (event) => {
  const method = (getMethod(event) ?? "GET").toUpperCase();

  // event.req.url is a bare path ("/health") on the Vercel web runtime; parse
  // with a base so it never throws whether absolute or relative.
  const rawUrl = (event.req as unknown as { url?: string }).url ?? "/";
  const pathname = new URL(rawUrl, "http://localhost").pathname;

  if (pathname === "/health" && method === "GET") {
    return buildHealthResponse();
  }

  if (pathname === "/mcp" || pathname === "/") {
    let parsedBody: unknown = undefined;
    if (method === "POST") {
      const bodyText = await readRequestBodyText(
        event as unknown as {
          req: unknown;
          runtime?: { node?: { req?: IncomingMessage } };
        },
      );
      if (bodyText.length > 0) {
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32700,
                message: "Parse error: request body must be JSON",
              },
              id: null,
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
      }
    }
    return handleWebMcpRequest({
      method,
      path: pathname,
      headers: extractHeaders(
        event as unknown as {
          req: { headers?: unknown };
          runtime?: { node?: { req?: IncomingMessage } };
        },
      ),
      parsedBody,
    });
  }

  return new Response(JSON.stringify({ error: "Not found", path: pathname }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
});
