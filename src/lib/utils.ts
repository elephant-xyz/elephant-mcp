import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { logger } from "../logger.ts";

/**
 * The helper always returns one or more text blocks, so callers can safely use
 * the narrow content shape while the value remains assignable to the MCP SDK.
 */
export type TextCallToolResult = CallToolResult & {
  content: Array<{ type: "text"; text: string }>;
};

/**
 * Creates a CallToolResult with text content from any data
 * Handles undefined values gracefully by converting them to null
 * @param data - The data to stringify and include in the result
 * @returns A properly formatted CallToolResult
 */
/** Log a failed tool call and return it as an MCP error result. */
export function toolError(message: string, error: unknown): TextCallToolResult {
  const details = error instanceof Error ? error.message : String(error);
  logger.error({ error: details }, message);
  return { ...createTextResult({ error: message, details }), isError: true };
}

export function createTextResult(data: unknown): TextCallToolResult {
  // Handle undefined gracefully by converting to null
  const safeData = data === undefined ? null : data;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(safeData, null, 2),
      },
    ],
  };
}
