/**
 * Unit tests for the property query engine's pure logic: SQL safety validation
 * and county → Parquet location resolution. These need no DuckDB/native binary
 * and run fast in CI. The real-parquet end-to-end assertions live in
 * ../tools/propertyQuery.test.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  validateSelectQuery,
  resolveQueryTableLocation,
  parseQueryTableMap,
} from "./duckdbQuery.ts";

describe("validateSelectQuery", () => {
  it("accepts a plain SELECT and strips a trailing semicolon", () => {
    const result = validateSelectQuery("SELECT * FROM properties;");
    expect(result).toEqual({ ok: true, sql: "SELECT * FROM properties" });
  });

  it("accepts a leading WITH/CTE query", () => {
    const sql = "WITH x AS (SELECT 1 AS n) SELECT n FROM x";
    const result = validateSelectQuery(sql);
    expect(result.ok).toBe(true);
  });

  it("does not trip on forbidden keywords inside string literals", () => {
    const result = validateSelectQuery(
      "SELECT * FROM properties WHERE owners_text ILIKE '%copy delete insert%'",
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an empty query", () => {
    const result = validateSelectQuery("   ");
    expect(result.ok).toBe(false);
  });

  it("rejects multiple statements", () => {
    const result = validateSelectQuery(
      "SELECT * FROM properties; DROP VIEW properties",
    );
    expect(result.ok).toBe(false);
  });

  it.each([
    ["INSERT", "INSERT INTO properties VALUES (1)"],
    ["UPDATE", "UPDATE properties SET owner_name = 'x'"],
    ["DELETE", "DELETE FROM properties"],
    ["COPY", "COPY (SELECT 1) TO '/tmp/out.csv'"],
    ["ATTACH", "ATTACH '/tmp/evil.db' AS evil"],
    ["INSTALL", "INSTALL httpfs"],
    ["PRAGMA", "PRAGMA database_list"],
    ["CALL", "CALL pragma_version()"],
  ])("rejects a non-SELECT %s statement", (_label, sql) => {
    const result = validateSelectQuery(sql);
    expect(result.ok).toBe(false);
  });

  it("rejects a data-modifying statement hidden behind a CTE", () => {
    const result = validateSelectQuery(
      "WITH x AS (SELECT 1) DELETE FROM properties",
    );
    expect(result.ok).toBe(false);
  });
});

describe("parseQueryTableMap", () => {
  it("returns an empty map for unset/blank/invalid input", () => {
    expect(parseQueryTableMap(undefined)).toEqual({});
    expect(parseQueryTableMap("")).toEqual({});
    expect(parseQueryTableMap("not json")).toEqual({});
    expect(parseQueryTableMap("[1,2,3]")).toEqual({});
  });

  it("normalizes county keys and drops blank locations", () => {
    const map = parseQueryTableMap(
      JSON.stringify({ Lee: "/a.parquet", "Palm Beach": "/b.parquet", X: "" }),
    );
    expect(map).toEqual({ lee: "/a.parquet", "palm-beach": "/b.parquet" });
  });
});

describe("resolveQueryTableLocation", () => {
  const ENV_KEYS = [
    "PROPERTY_QUERY_TABLE",
    "PROPERTY_QUERY_TABLE_MAP",
    "PROPERTY_QUERY_TABLE_DEFAULT_COUNTY",
  ];
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
      delete saved[key];
    }
  });

  function setEnv(env: Record<string, string | undefined>) {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  }

  it("resolves any county to the single table in legacy mode", () => {
    setEnv({ PROPERTY_QUERY_TABLE: "/lee.parquet" });
    const res = resolveQueryTableLocation("Lee");
    expect(res).toMatchObject({ served: true, location: "/lee.parquet" });
  });

  it("is not served when nothing is configured", () => {
    setEnv({});
    const res = resolveQueryTableLocation("Lee");
    expect(res.served).toBe(false);
    expect(res.location).toBeNull();
  });

  it("resolves a mapped county to its own location", () => {
    setEnv({
      PROPERTY_QUERY_TABLE_MAP: JSON.stringify({
        lee: "/lee.parquet",
        "palm-beach": "https://gw/pb.parquet",
      }),
    });
    expect(resolveQueryTableLocation("Palm Beach")).toMatchObject({
      served: true,
      location: "https://gw/pb.parquet",
    });
  });

  it("does not serve an unmapped county when a map is configured", () => {
    setEnv({
      PROPERTY_QUERY_TABLE_MAP: JSON.stringify({ lee: "/lee.parquet" }),
    });
    const res = resolveQueryTableLocation("Duval");
    expect(res.served).toBe(false);
    expect(res.location).toBeNull();
  });

  it("falls back to the single table for the configured default county", () => {
    setEnv({
      PROPERTY_QUERY_TABLE: "/single.parquet",
      PROPERTY_QUERY_TABLE_MAP: JSON.stringify({ lee: "/lee.parquet" }),
      PROPERTY_QUERY_TABLE_DEFAULT_COUNTY: "Duval",
    });
    expect(resolveQueryTableLocation("Duval")).toMatchObject({
      served: true,
      location: "/single.parquet",
    });
  });
});
