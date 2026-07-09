/**
 * Tests for the property query engine. Most cover the pure logic (SQL safety
 * validation and county → Parquet location resolution) and need no native
 * binary. One integration block exercises the real DuckDB httpfs path against a
 * localhost Parquet under an empty HOME. Further real-parquet end-to-end
 * assertions live in ../tools/propertyQuery.test.ts.
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  validateSelectQuery,
  resolveQueryTableLocation,
  parseQueryTableMap,
  runPropertyQuery,
  clearPropertyQueryConnections,
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

/**
 * Regression test for the serverless empty-HOME bug: opening an HTTP(S) query
 * table runs `INSTALL httpfs`, which writes under DuckDB's home directory. On
 * Vercel Functions HOME is empty, so INSTALL failed with "Can't find the home
 * directory at ''". The fix points home_directory at tmpdir() (overridable via
 * DUCKDB_HOME_DIRECTORY) before INSTALL. This exercises the real httpfs path
 * end-to-end — a Parquet range-read over localhost HTTP with HOME='' — so the
 * test fails if the home_directory fix is removed.
 */
describe("runPropertyQuery over an HTTP query table with empty HOME", () => {
  const SAVED_ENV = [
    "HOME",
    "PROPERTY_QUERY_TABLE_MAP",
    "PROPERTY_QUERY_TABLE",
    "PROPERTY_QUERY_TABLE_DEFAULT_COUNTY",
    "DUCKDB_HOME_DIRECTORY",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  let tmpDir: string;
  let parquetPath: string;
  let server: Server;

  beforeAll(async () => {
    for (const key of SAVED_ENV) saved[key] = process.env[key];

    tmpDir = mkdtempSync(join(tmpdir(), "duckdb-http-test-"));
    parquetPath = join(tmpDir, "x.parquet");

    // Generate the Parquet fixture at runtime with DuckDB itself (no committed
    // binary). Two columns mirror the shape the query engine reads.
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    const escaped = parquetPath.replace(/'/g, "''");
    await conn.run(
      `COPY (SELECT 1 AS request_identifier, 'x' AS owners_text) TO '${escaped}' (FORMAT PARQUET)`,
    );

    const fileBuf = readFileSync(parquetPath);

    // Serve the fixture over localhost with HTTP Range support — httpfs issues
    // range reads (and a HEAD for the size) rather than fetching the whole file.
    server = createServer((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "Content-Length": String(fileBuf.length),
          "Accept-Ranges": "bytes",
          "Content-Type": "application/octet-stream",
        });
        res.end();
        return;
      }

      const range = req.headers.range;
      const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
      if (match) {
        const total = fileBuf.length;
        const startRaw = match[1];
        const endRaw = match[2];
        let start: number;
        let end: number;
        if (startRaw === "") {
          // suffix range: last N bytes
          const suffix = Number(endRaw);
          start = Math.max(0, total - suffix);
          end = total - 1;
        } else {
          start = Number(startRaw);
          end = endRaw === "" ? total - 1 : Math.min(Number(endRaw), total - 1);
        }
        const slice = fileBuf.subarray(start, end + 1);
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(slice.length),
          "Content-Type": "application/octet-stream",
        });
        res.end(slice);
        return;
      }

      res.writeHead(200, {
        "Content-Length": String(fileBuf.length),
        "Accept-Ranges": "bytes",
        "Content-Type": "application/octet-stream",
      });
      res.end(fileBuf);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const port = (server.address() as AddressInfo).port;

    // Empty HOME reproduces the serverless failure mode; DUCKDB_HOME_DIRECTORY
    // is unset so the fix's tmpdir() fallback is the code path under test.
    process.env.HOME = "";
    delete process.env.DUCKDB_HOME_DIRECTORY;
    delete process.env.PROPERTY_QUERY_TABLE;
    delete process.env.PROPERTY_QUERY_TABLE_DEFAULT_COUNTY;
    process.env.PROPERTY_QUERY_TABLE_MAP = JSON.stringify({
      test: `http://127.0.0.1:${port}/x.parquet`,
    });

    clearPropertyQueryConnections();
  });

  afterAll(async () => {
    clearPropertyQueryConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    rmSync(tmpDir, { recursive: true, force: true });
    for (const key of SAVED_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("installs httpfs and range-reads the Parquet under empty HOME", async () => {
    const result = await runPropertyQuery(
      "test",
      "SELECT count(*) AS n FROM properties",
    );
    expect(result.rows).toHaveLength(1);
    expect(Number(result.rows[0].n)).toBe(1);
  }, 60_000);
});
