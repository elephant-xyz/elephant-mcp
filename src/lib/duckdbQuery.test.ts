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
import {
  describe,
  it,
  expect,
  vi,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  validateSelectQuery,
  resolveQueryTableLocation,
  parseQueryTableMap,
  parseQueryTableMapAdditions,
  parsePermitQueryTableMapAdditions,
  resolvePermitTableLocation,
  validateSelectQueryForView,
  runPropertyQuery,
  getPropertyColumns,
  clearPropertyQueryConnections,
  resolvePropertyQueryRuntimeLocation,
  resolvePermitQueryRuntimeLocation,
} from "./duckdbQuery.ts";

const ROCK_ISLAND_QUERY_TABLE_URL =
  "https://ipfs.filebase.io/ipns/k51qzi5uqu5djbtswq6lb4p7xbf3nu8bzdzokdtcdld1r2vx6asn7lgfuk54wt";
const ROCK_ISLAND_PERMIT_TABLE_URL =
  "https://ipfs.filebase.io/ipns/k51qzi5uqu5di42nblo5nuk94aj7af393d9y5vhqxp5dtxikzso0wt14v3p0wa";
const ROCK_ISLAND_QUERY_TABLE_CID =
  "QmQnm6W2Ye9GH3oD6SUswHrQCMegnpGbhRFgipitYW6zCc";
const ROCK_ISLAND_PERMIT_TABLE_CID =
  "QmYfhGF427Yvbv8B2e8rvP2idTQp5yEyKCgbj4bzRHGEaW";

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

describe("parseQueryTableMapAdditions", () => {
  it("returns an empty map when additions are absent", () => {
    expect(parseQueryTableMapAdditions(undefined)).toEqual({});
    expect(parseQueryTableMapAdditions("   ")).toEqual({});
  });

  it("normalizes county keys and validates absolute HTTP(S) URLs", () => {
    expect(
      parseQueryTableMapAdditions(
        JSON.stringify({
          " Rock Island ": `  ${ROCK_ISLAND_QUERY_TABLE_URL}  `,
        }),
      ),
    ).toEqual({ "rock-island": ROCK_ISLAND_QUERY_TABLE_URL });
  });

  it.each([
    ["malformed JSON", "{not-json", "contains invalid JSON"],
    ["non-object JSON", "[]", "must be a JSON object"],
    [
      "non-string value",
      JSON.stringify({ "rock-island": 42 }),
      "must be a non-empty string URL",
    ],
    [
      "relative location",
      JSON.stringify({ "rock-island": "/tmp/query.parquet" }),
      "must be an absolute HTTP(S) URL",
    ],
    [
      "unsupported protocol",
      JSON.stringify({ "rock-island": "s3://bucket/query.parquet" }),
      "must use http: or https:",
    ],
  ])("rejects %s", (_label, raw, expectedMessage) => {
    expect(() => parseQueryTableMapAdditions(raw)).toThrow(expectedMessage);
  });
});

describe("permit query-table additions", () => {
  it("strictly parses the Rock Island public URL", () => {
    expect(
      parsePermitQueryTableMapAdditions(
        JSON.stringify({
          " Rock Island ": ` ${ROCK_ISLAND_PERMIT_TABLE_URL} `,
        }),
      ),
    ).toEqual({ "rock-island": ROCK_ISLAND_PERMIT_TABLE_URL });
    expect(() =>
      parsePermitQueryTableMapAdditions(
        JSON.stringify({ "rock-island": "/private/local.parquet" }),
      ),
    ).toThrow("absolute HTTP(S) URL");
  });

  it("preserves Santa Clara while adding Rock Island", () => {
    const savedBase = process.env.PERMIT_QUERY_TABLE_MAP;
    const savedAdditions = process.env.PERMIT_QUERY_TABLE_MAP_ADDITIONS;
    process.env.PERMIT_QUERY_TABLE_MAP = JSON.stringify({
      "santa-clara": "https://example.com/santa-clara.parquet",
    });
    process.env.PERMIT_QUERY_TABLE_MAP_ADDITIONS = JSON.stringify({
      "rock-island": ROCK_ISLAND_PERMIT_TABLE_URL,
    });

    try {
      expect(resolvePermitTableLocation("Santa Clara")).toEqual({
        served: true,
        location: "https://example.com/santa-clara.parquet",
        countyKey: "santa-clara",
      });
      expect(resolvePermitTableLocation("Rock Island")).toEqual({
        served: true,
        location: ROCK_ISLAND_PERMIT_TABLE_URL,
        countyKey: "rock-island",
      });
    } finally {
      if (savedBase === undefined) delete process.env.PERMIT_QUERY_TABLE_MAP;
      else process.env.PERMIT_QUERY_TABLE_MAP = savedBase;
      if (savedAdditions === undefined) {
        delete process.env.PERMIT_QUERY_TABLE_MAP_ADDITIONS;
      } else {
        process.env.PERMIT_QUERY_TABLE_MAP_ADDITIONS = savedAdditions;
      }
    }
  });

  it("allows only the permits view and its CTEs", () => {
    expect(
      validateSelectQueryForView(
        "WITH issued AS (SELECT * FROM permits) SELECT count(*) FROM issued",
        "permits",
      ),
    ).toMatchObject({ ok: true });
    expect(
      validateSelectQueryForView(
        "SELECT * FROM read_parquet('https://example.com/private.parquet')",
        "permits",
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateSelectQueryForView("SELECT * FROM duckdb_tables", "permits"),
    ).toMatchObject({ ok: false });
  });
});

describe("resolveQueryTableLocation", () => {
  const ENV_KEYS = [
    "PROPERTY_QUERY_TABLE",
    "PROPERTY_QUERY_TABLE_MAP",
    "PROPERTY_QUERY_TABLE_MAP_ADDITIONS",
    "PROPERTY_QUERY_TABLE_CID_FALLBACK_MAP_ADDITIONS",
    "PERMIT_QUERY_TABLE_CID_FALLBACK_MAP_ADDITIONS",
    "PROPERTY_QUERY_TABLE_DEFAULT_COUNTY",
  ];
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
      delete saved[key];
    }
    vi.restoreAllMocks();
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

  it("adds Rock Island while preserving mapped counties and the default", () => {
    setEnv({
      PROPERTY_QUERY_TABLE_MAP: JSON.stringify({
        lee: "/lee.parquet",
        "palm-beach": "https://gw/pb.parquet",
      }),
      PROPERTY_QUERY_TABLE_MAP_ADDITIONS: JSON.stringify({
        "rock-island": ROCK_ISLAND_QUERY_TABLE_URL,
      }),
      PROPERTY_QUERY_TABLE_DEFAULT_COUNTY: "lee",
    });
    expect(resolveQueryTableLocation("Lee")).toEqual({
      served: true,
      location: "/lee.parquet",
      countyKey: "lee",
    });
    expect(resolveQueryTableLocation("Palm Beach")).toMatchObject({
      served: true,
      location: "https://gw/pb.parquet",
    });
    expect(resolveQueryTableLocation("Rock Island")).toEqual({
      served: true,
      location: ROCK_ISLAND_QUERY_TABLE_URL,
      countyKey: "rock-island",
    });
    expect(resolveQueryTableLocation(undefined)).toEqual({
      served: true,
      location: "/lee.parquet",
      countyKey: "lee",
    });
  });

  it("validates stable IPNS then selects the reviewed immutable query CID", async () => {
    setEnv({
      PROPERTY_QUERY_TABLE_CID_FALLBACK_MAP_ADDITIONS: JSON.stringify({
        "rock-island": ROCK_ISLAND_QUERY_TABLE_CID,
      }),
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: new Headers({
        "x-ipfs-roots": ROCK_ISLAND_QUERY_TABLE_CID,
      }),
    } as Response);

    await expect(
      resolvePropertyQueryRuntimeLocation(
        ROCK_ISLAND_QUERY_TABLE_URL,
        "rock-island",
      ),
    ).resolves.toBe(
      `https://ipfs.filebase.io/ipfs/${ROCK_ISLAND_QUERY_TABLE_CID}`,
    );
    expect(
      await resolvePropertyQueryRuntimeLocation(
        "https://example.com/lee.parquet",
        "lee",
      ),
    ).toBe("https://example.com/lee.parquet");
  });

  it("keeps permit IPNS primary while selecting its reviewed CID fallback", async () => {
    setEnv({
      PERMIT_QUERY_TABLE_CID_FALLBACK_MAP_ADDITIONS: JSON.stringify({
        "rock-island": ROCK_ISLAND_PERMIT_TABLE_CID,
      }),
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: new Headers({
        "x-ipfs-roots": "QmStalePermitCid",
      }),
    } as Response);

    await expect(
      resolvePermitQueryRuntimeLocation(
        ROCK_ISLAND_PERMIT_TABLE_URL,
        "rock-island",
      ),
    ).resolves.toBe(
      `https://ipfs.filebase.io/ipfs/${ROCK_ISLAND_PERMIT_TABLE_CID}`,
    );
    expect(
      await resolvePermitQueryRuntimeLocation(
        "https://example.com/santa-clara.parquet",
        "santa-clara",
      ),
    ).toBe("https://example.com/santa-clara.parquet");
  });

  it("accepts a same-value duplicate addition idempotently", () => {
    setEnv({
      PROPERTY_QUERY_TABLE_MAP: JSON.stringify({
        "rock-island": ROCK_ISLAND_QUERY_TABLE_URL,
      }),
      PROPERTY_QUERY_TABLE_MAP_ADDITIONS: JSON.stringify({
        "rock-island": ROCK_ISLAND_QUERY_TABLE_URL,
      }),
    });

    expect(resolveQueryTableLocation("rock-island")).toEqual({
      served: true,
      location: ROCK_ISLAND_QUERY_TABLE_URL,
      countyKey: "rock-island",
    });
  });

  it("fails closed when an addition conflicts with the base map", () => {
    setEnv({
      PROPERTY_QUERY_TABLE_MAP: JSON.stringify({
        "rock-island": "https://example.com/original.parquet",
      }),
      PROPERTY_QUERY_TABLE_MAP_ADDITIONS: JSON.stringify({
        "rock-island": ROCK_ISLAND_QUERY_TABLE_URL,
      }),
    });

    expect(() => resolveQueryTableLocation("rock-island")).toThrow(
      "PROPERTY_QUERY_TABLE_MAP_ADDITIONS conflicts with PROPERTY_QUERY_TABLE_MAP for county 'rock-island'",
    );
  });

  it("preserves base behavior when additions are absent", () => {
    setEnv({
      PROPERTY_QUERY_TABLE_MAP: JSON.stringify({
        lee: "/lee.parquet",
        "palm-beach": "https://gw/pb.parquet",
      }),
      PROPERTY_QUERY_TABLE_DEFAULT_COUNTY: "lee",
    });

    expect(resolveQueryTableLocation("lee").location).toBe("/lee.parquet");
    expect(resolveQueryTableLocation("palm-beach").location).toBe(
      "https://gw/pb.parquet",
    );
    expect(resolveQueryTableLocation(undefined).countyKey).toBe("lee");
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
 * Build a minimal DuckDB instance/connection double for connection lifecycle
 * tests. The production code sees the real API shape while tests retain access
 * to each call for county/location assertions.
 *
 * @param columnName - Column name returned from DESCRIBE.
 * @returns DuckDB instance double plus its observable methods.
 */
function createDuckDbDouble(columnName: string) {
  const reader = {
    getRowObjectsJson: vi.fn().mockReturnValue([
      {
        column_name: columnName,
        column_type: "VARCHAR",
      },
    ]),
  };
  const connection = {
    run: vi.fn().mockResolvedValue(undefined),
    runAndReadAll: vi.fn().mockResolvedValue(reader),
  };
  const instance = {
    connect: vi.fn().mockResolvedValue(connection),
  };
  return { instance, connection };
}

describe("lazy county-scoped DuckDB initialization", () => {
  const LEE_URL = "https://example.com/lee.parquet";
  const ROCK_URL = "https://example.com/rock-island.parquet";
  type DuckDbInstance = Awaited<ReturnType<typeof DuckDBInstance.create>>;

  afterEach(() => {
    clearPropertyQueryConnections();
    delete process.env.PROPERTY_QUERY_TABLE;
    delete process.env.PROPERTY_QUERY_TABLE_MAP;
    delete process.env.PROPERTY_QUERY_TABLE_MAP_ADDITIONS;
    delete process.env.PROPERTY_QUERY_TABLE_DEFAULT_COUNTY;
    vi.restoreAllMocks();
  });

  it("opens only the requested county and leaves other map entries cold", async () => {
    process.env.PROPERTY_QUERY_TABLE_MAP = JSON.stringify({
      lee: LEE_URL,
      "rock-island": ROCK_URL,
    });
    const rock = createDuckDbDouble("rock_column");
    const createSpy = vi
      .spyOn(DuckDBInstance, "create")
      .mockResolvedValue(rock.instance as unknown as DuckDbInstance);

    const columns = await getPropertyColumns("Rock Island");

    expect(columns).toEqual([{ name: "rock_column", type: "VARCHAR" }]);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(
      rock.connection.run.mock.calls.some(([sql]) =>
        String(sql).includes(`read_parquet('${ROCK_URL}')`),
      ),
    ).toBe(true);
    expect(
      rock.connection.run.mock.calls.some(([sql]) =>
        String(sql).includes(LEE_URL),
      ),
    ).toBe(false);
  });

  it("shares one pending initialization across concurrent first calls", async () => {
    process.env.PROPERTY_QUERY_TABLE_MAP = JSON.stringify({
      "rock-island": ROCK_URL,
    });
    const rock = createDuckDbDouble("rock_column");
    let resolveCreate: ((instance: DuckDbInstance) => void) | undefined;
    const pendingCreate = new Promise<DuckDbInstance>((resolve) => {
      resolveCreate = resolve;
    });
    const createSpy = vi
      .spyOn(DuckDBInstance, "create")
      .mockReturnValue(pendingCreate);

    const first = getPropertyColumns("Rock Island");
    const second = getPropertyColumns("Rock Island");
    await Promise.resolve();

    expect(createSpy).toHaveBeenCalledTimes(1);
    resolveCreate?.(rock.instance as unknown as DuckDbInstance);
    const [firstColumns, secondColumns] = await Promise.all([first, second]);

    expect(firstColumns).toEqual(secondColumns);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(rock.instance.connect).toHaveBeenCalledTimes(1);
  });

  it("retries a failed county without evicting another county connection", async () => {
    process.env.PROPERTY_QUERY_TABLE_MAP = JSON.stringify({
      lee: LEE_URL,
      "rock-island": ROCK_URL,
    });
    const lee = createDuckDbDouble("lee_column");
    const rock = createDuckDbDouble("rock_column");
    const createSpy = vi
      .spyOn(DuckDBInstance, "create")
      .mockRejectedValueOnce(new Error("temporary Rock Island open failure"))
      .mockResolvedValueOnce(lee.instance as unknown as DuckDbInstance)
      .mockResolvedValueOnce(rock.instance as unknown as DuckDbInstance);

    await expect(getPropertyColumns("Rock Island")).rejects.toThrow(
      "temporary Rock Island open failure",
    );
    await expect(getPropertyColumns("Lee")).resolves.toEqual([
      { name: "lee_column", type: "VARCHAR" },
    ]);
    await expect(getPropertyColumns("Rock Island")).resolves.toEqual([
      { name: "rock_column", type: "VARCHAR" },
    ]);
    await expect(getPropertyColumns("Lee")).resolves.toEqual([
      { name: "lee_column", type: "VARCHAR" },
    ]);

    expect(createSpy).toHaveBeenCalledTimes(3);
    expect(lee.instance.connect).toHaveBeenCalledTimes(1);
    expect(rock.instance.connect).toHaveBeenCalledTimes(1);
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
    "PROPERTY_QUERY_TABLE_MAP_ADDITIONS",
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
    delete process.env.PROPERTY_QUERY_TABLE_MAP_ADDITIONS;
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
