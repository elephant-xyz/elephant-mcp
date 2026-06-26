/**
 * Story 3 — AC1: registry smoke test for the new geo/value tools.
 *
 * INTENTIONALLY RED until registry.ts registers the two new tools.
 *
 * The registry is the single source of truth for tool definitions (both the
 * stdio and HTTP transports call registerAllTools). This test fails until
 * `findPropertiesInArea` and `sumPropertyValueInArea` are registered there.
 */

import { describe, it, expect } from "vitest";
import { registerAllTools } from "./registry.ts";

/** A minimal fake McpServer that records the names of registered tools. */
function makeRecordingServer() {
  const names: string[] = [];
  const server = {
    registerTool(name: string) {
      names.push(name);
    },
  };
  return { server, names };
}

describe("registerAllTools — geo tool registration (red)", () => {
  it("registers the findPropertiesInArea tool", () => {
    const { server, names } = makeRecordingServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAllTools(server as any);
    expect(names).toContain("findPropertiesInArea");
  });

  it("registers the sumPropertyValueInArea tool", () => {
    const { server, names } = makeRecordingServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAllTools(server as any);
    expect(names).toContain("sumPropertyValueInArea");
  });

  it("keeps the existing oracle tools registered alongside the new geo tools", () => {
    const { server, names } = makeRecordingServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAllTools(server as any);
    // Existing tools must not regress.
    expect(names).toEqual(
      expect.arrayContaining([
        "listOracleProperties",
        "getOracleProperty",
        "getOracleDatasetInfo",
      ]),
    );
  });
});
