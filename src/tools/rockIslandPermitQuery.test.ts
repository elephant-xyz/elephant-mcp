import { createServer, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clearPermitQueryConnections } from "../lib/duckdbQuery.ts";
import {
  ROCK_ISLAND_PERMIT_PUBLIC_COLUMNS,
  ROCK_ISLAND_PERMIT_SCOPE_NOTE,
} from "../lib/rockIslandPermit.ts";
import {
  getPermitCoverageHandler,
  getPermitQuerySchemaHandler,
  queryPermitsHandler,
} from "./permitQuery.ts";
import { registerAllTools } from "./registry.ts";

const PERMIT_ENV_KEYS = [
  "HOME",
  "DUCKDB_HOME_DIRECTORY",
  "PERMIT_QUERY_TABLE_MAP",
  "PERMIT_QUERY_TABLE_MAP_ADDITIONS",
  "PERMIT_QUERY_TABLE",
  "PERMIT_QUERY_TABLE_DEFAULT_COUNTY",
] as const;

/**
 * Parse the first text result returned by an MCP handler.
 *
 * @param result - Text-only MCP handler result.
 * @returns Parsed JSON object.
 */
function parseResult(result: {
  readonly content: readonly (
    | { readonly type: "text"; readonly text: string }
    | { readonly type: string }
  )[];
}): Record<string, unknown> {
  const item = result.content[0];
  if (item?.type !== "text" || !("text" in item)) {
    throw new Error("Expected an MCP text result");
  }
  return JSON.parse(item.text) as Record<string, unknown>;
}

/**
 * Write a closed public Rock Island permit fixture.
 *
 * @param path - Destination Parquet path.
 * @param includeDriftColumn - Whether to append an unapproved field.
 * @returns Completion after writing the fixture.
 */
async function writePermitParquet(
  path: string,
  includeDriftColumn: boolean,
): Promise<void> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const escaped = path.replace(/'/gu, "''");
  const drift = includeDriftColumn
    ? ", 'must-fail'::VARCHAR AS private_address"
    : "";
  await connection.run(`
    COPY (
      SELECT
        permit_key::VARCHAR AS permit_key,
        'rock_island_city_official_monthly_permit_reports'::VARCHAR AS source_system,
        document_id::VARCHAR AS source_report_document_id,
        report_title::VARCHAR AS source_report_title,
        report_url::VARCHAR AS source_report_url,
        permit_number::VARCHAR AS permit_number,
        permit_issue_date::VARCHAR AS permit_issue_date,
        'Issued'::VARCHAR AS record_status,
        record_type::VARCHAR AS record_type,
        'Rock Island'::VARCHAR AS city,
        is_roof_permit::BOOLEAN AS is_roof_permit
        ${drift}
      FROM (
        VALUES
          ('source:1001', '501', 'January 2017 permits', 'https://www.rigov.org/DocumentCenter/View/501/report', '1001', '2017-01-03', 'roof', true),
          ('source:2002', '999', 'April 2026 permits', 'https://www.rigov.org/DocumentCenter/View/999/report', '2002', '2026-04-30', 'Electrical', false)
      ) AS fixture(
        permit_key,
        document_id,
        report_title,
        report_url,
        permit_number,
        permit_issue_date,
        record_type,
        is_roof_permit
      )
    ) TO '${escaped}' (FORMAT PARQUET)
  `);
}

/**
 * Serve a complete file with HTTP byte-range support for DuckDB httpfs.
 *
 * @param range - Incoming Range header.
 * @param body - Complete Parquet bytes.
 * @param response - HTTP response.
 * @param isHead - Whether only headers should be sent.
 * @returns Nothing.
 */
function sendRangeFile(
  range: string | undefined,
  body: Buffer,
  response: ServerResponse,
  isHead: boolean,
): void {
  if (isHead) {
    response.writeHead(200, {
      "Content-Length": String(body.length),
      "Accept-Ranges": "bytes",
    });
    response.end();
    return;
  }
  const match = range === undefined ? null : /^bytes=(\d*)-(\d*)$/u.exec(range);
  if (match !== null) {
    const startText = match[1] ?? "";
    const endText = match[2] ?? "";
    const start =
      startText === ""
        ? Math.max(0, body.length - Number(endText))
        : Number(startText);
    const end =
      startText === ""
        ? body.length - 1
        : endText === ""
          ? body.length - 1
          : Math.min(Number(endText), body.length - 1);
    const part = body.subarray(start, end + 1);
    response.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${body.length}`,
      "Content-Length": String(part.length),
      "Accept-Ranges": "bytes",
    });
    response.end(part);
    return;
  }
  response.writeHead(200, {
    "Content-Length": String(body.length),
    "Accept-Ranges": "bytes",
  });
  response.end(body);
}

describe("Rock Island safe permit query surface", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let directory: string;
  let server: Server;
  let origin: string;
  let safeParquet: Buffer;
  let driftParquet: Buffer;

  beforeAll(async () => {
    for (const key of PERMIT_ENV_KEYS) savedEnv[key] = process.env[key];
    directory = mkdtempSync(join(tmpdir(), "rock-island-permits-"));
    const safePath = join(directory, "safe.parquet");
    const driftPath = join(directory, "drift.parquet");
    await writePermitParquet(safePath, false);
    await writePermitParquet(driftPath, true);
    safeParquet = readFileSync(safePath);
    driftParquet = readFileSync(driftPath);

    server = createServer((request, response) => {
      const body =
        request.url === "/safe"
          ? safeParquet
          : request.url === "/drift"
            ? driftParquet
            : null;
      if (body === null) {
        response.writeHead(404);
        response.end();
        return;
      }
      sendRangeFile(
        request.headers.range,
        body,
        response,
        request.method === "HEAD",
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;

    process.env.HOME = "";
    delete process.env.DUCKDB_HOME_DIRECTORY;
    process.env.PERMIT_QUERY_TABLE_MAP = JSON.stringify({
      "santa-clara": "https://example.com/santa-clara.parquet",
    });
    process.env.PERMIT_QUERY_TABLE_MAP_ADDITIONS = JSON.stringify({
      "rock-island": `${origin}/safe`,
    });
    delete process.env.PERMIT_QUERY_TABLE;
    delete process.env.PERMIT_QUERY_TABLE_DEFAULT_COUNTY;
    clearPermitQueryConnections();
  }, 60_000);

  afterAll(async () => {
    clearPermitQueryConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(directory, { recursive: true, force: true });
    for (const key of PERMIT_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("documents the issued-report limitation on every permit tool", () => {
    const registrations = new Map<string, string>();
    const recordingServer = {
      registerTool(
        name: string,
        definition: { readonly description?: string },
      ): void {
        registrations.set(name, definition.description ?? "");
      },
    };
    registerAllTools(recordingServer as unknown as McpServer);
    for (const name of [
      "queryPermits",
      "getPermitQuerySchema",
      "getPermitCoverage",
    ]) {
      expect(registrations.get(name)).toContain("47,385 records");
      expect(registrations.get(name)).toContain("Sixty-one");
      expect(registrations.get(name)).toContain(
        "not complete permit lifecycle",
      );
    }
  });

  it("returns only the exact public columns and scope note", async () => {
    const count = parseResult(
      await queryPermitsHandler({
        county: "Rock Island",
        sql: "SELECT count(*) AS permit_count FROM permits",
      }),
    );
    const sample = parseResult(
      await queryPermitsHandler({
        county: "Rock Island",
        sql: "SELECT * FROM permits ORDER BY permit_key",
        limit: 1,
      }),
    );
    const countRows = count.rows as Array<Record<string, unknown>>;
    const sampleRows = sample.rows as Array<Record<string, unknown>>;

    expect(Number(countRows[0]?.permit_count)).toBe(2);
    expect(Object.keys(sampleRows[0] ?? {})).toEqual(
      ROCK_ISLAND_PERMIT_PUBLIC_COLUMNS,
    );
    expect(sample.scopeNote).toBe(ROCK_ISLAND_PERMIT_SCOPE_NOTE);
  }, 60_000);

  it("reports the exact safe schema and issue-date coverage", async () => {
    const schema = parseResult(
      await getPermitQuerySchemaHandler({ county: "rock-island" }),
    );
    const columns = schema.columns as Array<{ readonly name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      ROCK_ISLAND_PERMIT_PUBLIC_COLUMNS,
    );
    expect(schema.scopeNote).toBe(ROCK_ISLAND_PERMIT_SCOPE_NOTE);

    const coverage = parseResult(
      await getPermitCoverageHandler({ county: "rock-island" }),
    );
    const sources = coverage.sources as Array<Record<string, unknown>>;
    expect(coverage.totalPermits).toBe(2);
    expect(sources[0]?.earliest_date).toBe("2017-01-03");
    expect(sources[0]?.latest_date).toBe("2026-04-30");
    expect(coverage.scopeNote).toBe(ROCK_ISLAND_PERMIT_SCOPE_NOTE);
  }, 60_000);

  it("rejects external relations and preserves the scope note", async () => {
    const result = parseResult(
      await queryPermitsHandler({
        county: "Rock Island",
        sql: "SELECT * FROM read_parquet('https://example.com/private.parquet')",
      }),
    );
    expect(result.details).toContain("external table functions are rejected");
    expect(result.scopeNote).toBe(ROCK_ISLAND_PERMIT_SCOPE_NOTE);
  });

  it("fails closed when the Rock Island Parquet schema drifts", async () => {
    process.env.PERMIT_QUERY_TABLE_MAP_ADDITIONS = JSON.stringify({
      "rock-island": `${origin}/drift`,
    });
    clearPermitQueryConnections();
    try {
      const result = parseResult(
        await queryPermitsHandler({
          county: "Rock Island",
          sql: "SELECT * FROM permits",
        }),
      );
      expect(result.details).toContain(
        "source schema drifted from the exact public allowlist",
      );
      expect(result.scopeNote).toBe(ROCK_ISLAND_PERMIT_SCOPE_NOTE);
    } finally {
      process.env.PERMIT_QUERY_TABLE_MAP_ADDITIONS = JSON.stringify({
        "rock-island": `${origin}/safe`,
      });
      clearPermitQueryConnections();
    }
  }, 60_000);
});
