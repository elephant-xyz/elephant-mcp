/**
 * Tests for the queryProperties / getPropertyQuerySchema tools.
 *
 * The end-to-end assertions run against the REAL validated Lee query-table
 * Parquet produced by step 1 (203 MB, 511,695 rows). If that file is not
 * present (e.g. a fresh CI checkout without the export), the DB-backed block is
 * skipped, but the safety/registration tests — which need no Parquet — always
 * run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import {
  queryPropertiesHandler,
  getPropertyQuerySchemaHandler,
} from "./propertyQuery.ts";
import { registerAllTools } from "./registry.ts";
import { clearPropertyQueryConnections } from "../lib/duckdbQuery.ts";

const LEE_PARQUET =
  "/Users/stefanmicic/Desktop/Klijenti/elephant/elephant-query-db/.query-table-export/lee/query-table.parquet";
const LEE_ROW_COUNT = 511695;
const hasLeeParquet = existsSync(LEE_PARQUET);

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

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

describe("registerAllTools — property query tools", () => {
  it("registers queryProperties and getPropertyQuerySchema", () => {
    const { server, names } = makeRecordingServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAllTools(server as any);
    expect(names).toEqual(
      expect.arrayContaining(["queryProperties", "getPropertyQuerySchema"]),
    );
  });
});

describe("queryPropertiesHandler — safety (no Parquet needed)", () => {
  it("rejects a non-SELECT statement with an error result", async () => {
    const result = await queryPropertiesHandler({
      county: "Lee",
      sql: "DROP VIEW properties",
    });
    const parsed = parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.rows).toBeUndefined();
  });

  it("rejects multiple statements", async () => {
    const result = await queryPropertiesHandler({
      county: "Lee",
      sql: "SELECT 1; SELECT 2",
    });
    expect(parse(result).error).toBeDefined();
  });
});

describe.skipIf(!hasLeeParquet)(
  "queryProperties against the real Lee query table",
  () => {
    beforeAll(() => {
      process.env.PROPERTY_QUERY_TABLE = LEE_PARQUET;
      delete process.env.PROPERTY_QUERY_TABLE_MAP;
      delete process.env.PROPERTY_QUERY_TABLE_DEFAULT_COUNTY;
      clearPropertyQueryConnections();
    });

    afterAll(() => {
      delete process.env.PROPERTY_QUERY_TABLE;
      clearPropertyQueryConnections();
    });

    it("counts all 511,695 rows", async () => {
      const result = await queryPropertiesHandler({
        county: "Lee",
        sql: "SELECT count(*) AS c FROM properties",
      });
      const parsed = parse(result);
      expect(parsed.error).toBeUndefined();
      expect(Number(parsed.rows[0].c)).toBe(LEE_ROW_COUNT);
    }, 60_000);

    it("finds owners by free-text search (Bailey)", async () => {
      const result = await queryPropertiesHandler({
        county: "Lee",
        sql: "SELECT owner_name FROM properties WHERE owners_text ILIKE '%Bailey%'",
        limit: 5,
      });
      const parsed = parse(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.rows.length).toBeGreaterThanOrEqual(1);
      expect(parsed.rows.length).toBeLessThanOrEqual(5);
    }, 60_000);

    it("enforces the row cap regardless of the caller's own LIMIT", async () => {
      const result = await queryPropertiesHandler({
        county: "Lee",
        sql: "SELECT property_id FROM properties LIMIT 999999",
        limit: 10,
      });
      const parsed = parse(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.limit).toBe(10);
      expect(parsed.rows.length).toBe(10);
    }, 60_000);

    it("reports the schema with column descriptions", async () => {
      const result = await getPropertyQuerySchemaHandler({ county: "Lee" });
      const parsed = parse(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.columnCount).toBeGreaterThan(0);
      const names = parsed.columns.map((c: { name: string }) => c.name);
      expect(names).toContain("owners_text");
      const ownersText = parsed.columns.find(
        (c: { name: string }) => c.name === "owners_text",
      );
      expect(ownersText.description).toBeTruthy();
      expect(parsed.nullabilityNote).toContain("hoa_flag");
    }, 60_000);
  },
);
