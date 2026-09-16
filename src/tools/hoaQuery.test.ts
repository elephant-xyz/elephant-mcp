import { describe, it, expect } from "vitest";

import { queryHoasHandler, getHoaQuerySchemaHandler } from "./hoaQuery.ts";
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

describe("registerAllTools — HOA registry tools", () => {
  it("registers queryHoas and getHoaQuerySchema", () => {
    const { server, names } = makeRecordingServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAllTools(server as any);
    expect(names).toEqual(
      expect.arrayContaining(["queryHoas", "getHoaQuerySchema"]),
    );
  });
});

describe("queryHoasHandler — safety", () => {
  it("rejects a non-SELECT statement", async () => {
    const result = await queryHoasHandler({
      sql: "DROP VIEW hoas",
    });
    const parsed = parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.rows).toBeUndefined();
  });

  it("rejects multiple statements", async () => {
    const result = await queryHoasHandler({
      sql: "SELECT 1; SELECT 2",
    });
    expect(parse(result).error).toBeDefined();
  });
});

describe("getHoaQuerySchemaHandler — missing map", () => {
  it("fails closed when HOA_QUERY_TABLE_MAP is empty", async () => {
    delete process.env.HOA_QUERY_TABLE_MAP;
    delete process.env.HOA_QUERY_TABLE;
    const result = await getHoaQuerySchemaHandler({});
    expect(parse(result).error).toBeDefined();
  });
});
