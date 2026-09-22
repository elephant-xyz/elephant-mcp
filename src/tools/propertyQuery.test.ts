import { describe, expect, it } from "vitest";

import { queryPropertiesHandler } from "./propertyQuery.ts";
import { registerAllTools } from "./registry.ts";

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function makeRecordingServer() {
  const names: string[] = [];
  const server = {
    registerTool(name: string) {
      names.push(name);
    },
  };
  return { server, names };
}

describe("registerAllTools — property query tools", () => {
  it("registers queryAtlas and getAtlasSchema", () => {
    const { server, names } = makeRecordingServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAllTools(server as any);
    expect(names).toEqual(
      expect.arrayContaining(["queryAtlas", "getAtlasSchema"]),
    );
  });
});

describe("queryPropertiesHandler — safety (no Parquet needed)", () => {
  it("rejects a non-SELECT statement with an error result", async () => {
    const result = await queryPropertiesHandler({
      county: "lee",
      dataGroup: "county",
      state: "FL",
      sql: "DROP VIEW properties",
    });
    const parsed = parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.rows).toBeUndefined();
  });

  it("rejects multiple statements", async () => {
    const result = await queryPropertiesHandler({
      county: "lee",
      dataGroup: "county",
      state: "FL",
      sql: "SELECT 1; SELECT 2",
    });
    expect(parse(result).error).toBeDefined();
  });
  it("rejects direct access to Atlas control tables", async () => {
    const result = await queryPropertiesHandler({
      county: "lee",
      dataGroup: "county",
      state: "FL",
      sql: "SELECT * FROM atlas_state",
    });
    expect(parse(result).error).toBeDefined();
  });
});
