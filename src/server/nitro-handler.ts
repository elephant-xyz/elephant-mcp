/**
 * Nitro event handler — thin h3 bridge to the MCP HTTP request handler.
 *
 * h3 wraps Node IncomingMessage/ServerResponse via `fromNodeMiddleware`, which
 * is exactly what StreamableHTTPServerTransport.handleRequest() consumes. So
 * the same stateless MCP handler works under all Nitro presets.
 */
import { defineEventHandler, fromNodeMiddleware } from "h3";
import { handleHttpRequest } from "./http.ts";

export default defineEventHandler(
  fromNodeMiddleware((req, res, next) => {
    void handleHttpRequest(req, res).catch((err: unknown) => {
      next(err as Error);
    });
  }),
);
