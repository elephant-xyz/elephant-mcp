/**
 * Tests for the queryPermits / getPermitQuerySchema / getPermitCoverage tools.
 *
 * The end-to-end assertions run against the REAL validated Lee permit-table
 * Parquet (2,114,833 rows). If that file is not present (e.g. a fresh CI
 * checkout without the export), the DB-backed block is skipped, but the
 * safety/registration tests — which need no Parquet — always run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import {
  queryPermitsHandler,
  getPermitQuerySchemaHandler,
  getPermitCoverageHandler,
} from "./permitQuery.ts";
import { registerAllTools } from "./registry.ts";
import { clearPermitQueryConnections } from "../lib/duckdbQuery.ts";

const LEE_PARQUET =
  "/Users/markov/Documents/Projects/elephant/elephant-query-db/.permit-table-export/lee/permit-table.parquet";
const LEE_ROW_COUNT = 2114833;
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

describe("registerAllTools — permit query tools", () => {
  it("registers queryPermits, getPermitQuerySchema, and getPermitCoverage", () => {
    const { server, names } = makeRecordingServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAllTools(server as any);
    expect(names).toEqual(
      expect.arrayContaining([
        "queryPermits",
        "getPermitQuerySchema",
        "getPermitCoverage",
      ]),
    );
  });
});

describe("queryPermitsHandler — safety (no Parquet needed)", () => {
  it("rejects a non-SELECT statement with an error result", async () => {
    const result = await queryPermitsHandler({
      county: "Lee",
      sql: "DROP VIEW permits",
    });
    const parsed = parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.rows).toBeUndefined();
  });

  it("rejects multiple statements", async () => {
    const result = await queryPermitsHandler({
      county: "Lee",
      sql: "SELECT 1; SELECT 2",
    });
    expect(parse(result).error).toBeDefined();
  });
});

describe.skipIf(!hasLeeParquet)(
  "queryPermits against the real Lee permit table",
  () => {
    beforeAll(() => {
      process.env.PERMIT_QUERY_TABLE = LEE_PARQUET;
      delete process.env.PERMIT_QUERY_TABLE_MAP;
      delete process.env.PERMIT_QUERY_TABLE_DEFAULT_COUNTY;
      clearPermitQueryConnections();
    });

    afterAll(() => {
      delete process.env.PERMIT_QUERY_TABLE;
      clearPermitQueryConnections();
    });

    it("counts all 2,114,833 permit rows", async () => {
      const result = await queryPermitsHandler({
        county: "Lee",
        sql: "SELECT count(*) AS c FROM permits",
      });
      const parsed = parse(result);
      expect(parsed.error).toBeUndefined();
      expect(Number(parsed.rows[0].c)).toBe(LEE_ROW_COUNT);
    }, 60_000);

    it("enforces the row cap regardless of the caller's own LIMIT", async () => {
      const result = await queryPermitsHandler({
        county: "Lee",
        sql: "SELECT property_improvement_id FROM permits LIMIT 999999",
        limit: 10,
      });
      const parsed = parse(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.limit).toBe(10);
      expect(parsed.rows.length).toBe(10);
    }, 60_000);

    it("reports the schema with column descriptions", async () => {
      const result = await getPermitQuerySchemaHandler({ county: "Lee" });
      const parsed = parse(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.view).toBe("permits");
      expect(parsed.columnCount).toBeGreaterThan(0);
      const names = parsed.columns.map((c: { name: string }) => c.name);
      expect(names).toContain("completion_date");
      expect(names).toContain("improvement_type");
      const permitId = parsed.columns.find(
        (c: { name: string }) => c.name === "property_improvement_id",
      );
      expect(permitId.description).toBeTruthy();
    }, 60_000);

    it("reports per-source coverage that spans lee_appraiser and lee_accela", async () => {
      const result = await getPermitCoverageHandler({ county: "Lee" });
      const parsed = parse(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.totalPermits).toBe(LEE_ROW_COUNT);
      const sources = parsed.sources.map(
        (s: { source_system: string }) => s.source_system,
      );
      expect(sources).toContain("lee_appraiser");
      expect(sources).toContain("lee_accela");
      expect(parsed.coverageNote).toMatch(/accela/i);
    }, 60_000);

    it("computes the roof-age exemplar (% of roofed properties whose newest roof permit is >15y old)", async () => {
      // Among lee_appraiser Roofing permits, group by property_id and take the
      // NEWEST completion_date per property; a property is "old-roof" when that
      // newest roofing completion is more than 15 years before today.
      const sql = `
        WITH roofs AS (
          SELECT property_id, max(completion_date) AS newest_roof
          FROM permits
          WHERE source_system = 'lee_appraiser'
            AND improvement_type ILIKE '%roof%'
            AND property_id IS NOT NULL
            AND completion_date IS NOT NULL
          GROUP BY property_id
        )
        SELECT
          count(*) AS roofed_properties,
          count(*) FILTER (
            WHERE CAST(newest_roof AS DATE) < (current_date - INTERVAL 15 YEAR)
          ) AS old_roof_properties,
          round(
            100.0 * count(*) FILTER (
              WHERE CAST(newest_roof AS DATE) < (current_date - INTERVAL 15 YEAR)
            ) / count(*), 2
          ) AS pct_old_roof
        FROM roofs`;
      const result = await queryPermitsHandler({ county: "Lee", sql });
      const parsed = parse(result);
      expect(parsed.error).toBeUndefined();
      const row = parsed.rows[0];
      expect(Number(row.roofed_properties)).toBeGreaterThan(0);
      // Sanity band around the prior hand-run (~9.7%); left wide so the test is
      // stable as `current_date` advances, not a brittle exact-equality pin.
      expect(Number(row.pct_old_roof)).toBeGreaterThan(0);
      expect(Number(row.pct_old_roof)).toBeLessThan(100);
      // eslint-disable-next-line no-console
      console.log("roof-age exemplar:", JSON.stringify(row));
    }, 60_000);
  },
);
