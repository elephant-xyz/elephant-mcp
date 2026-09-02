import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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
