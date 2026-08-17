import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  clearCorporateQueryConnections,
  parseCorporateManifestMapAdditions,
  resolveCorporateManifestLocation,
  validateSelectQueryForView,
} from "../lib/duckdbQuery.ts";
import {
  CORPORATE_PUBLIC_COLUMNS,
  CORPORATE_SCOPE_NOTE,
  clearCorporateManifestCache,
} from "../lib/corporateManifest.ts";
import { registerAllTools } from "./registry.ts";
import {
  getCorporateQuerySchemaHandler,
  queryCorporationsHandler,
} from "./corporateQuery.ts";

const PARQUET_CID = "QmY44DzhzYcTBjVbjQhDYdcpfMCoPpPFcUs8tjuk7cCbqJ";
const SCHEMA_CID = "QmWxP8FaU2KQ4fsrrEnjTTNVxjvzQscLtwskZFdmopSwMJ";
const CORPORATE_ENV_KEYS = [
  "HOME",
  "DUCKDB_HOME_DIRECTORY",
  "CORPORATE_REGISTRATION_MANIFEST_MAP",
  "CORPORATE_REGISTRATION_MANIFEST_MAP_ADDITIONS",
  "CORPORATE_REGISTRATION_MANIFEST",
  "CORPORATE_REGISTRATION_DEFAULT_COUNTY",
] as const;

/**
 * Decode the first text item returned by an MCP handler.
 *
 * @param result - MCP tool result with heterogeneous content item support.
 * @returns Parsed JSON result object.
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
 * Build a strict public corporate manifest for an isolated Parquet fixture.
 *
 * @param parquetCid - CID-shaped path served by the local HTTP gateway.
 * @param rowCount - Expected unique organization count.
 * @returns Exact manifest contract accepted by the production validator.
 */
function buildManifest(parquetCid: string, rowCount: number) {
  return {
    schemaVersion: "illinois-sos-rock-island-corporate-registration-public-v1",
    dataset: "rock_island_corporate_registrations",
    exportedAt: "2026-08-14T17:40:00.000Z",
    rowCount,
    uniqueIllinoisFileNumberCount: rowCount,
    sourceSystem: "illinois_sos",
    scope: {
      type: "registered_agent_office_county",
      countyCode: "081",
      countyLabel: "Rock Island",
      meaning: "organization has a registered-agent office county code of 081",
      doesNotEstablish: [
        "operating_location",
        "tenancy",
        "ownership",
        "occupancy",
      ],
    },
    componentSnapshots: {
      master: "2026-07-29",
      name: "2026-07-28",
      agent: "2026-07-29",
    },
    snapshotConsistency: "mixed_date",
    statewideIntersection: {
      sourceCount: 1981387,
      includedCount: 1981254,
      excludedCount: 133,
      coveragePercent: 99.9933,
      excludedCounty081Count: 0,
    },
    privacy: {
      classification: "public_non_pii_organization_registry",
      allowlistColumns: [...CORPORATE_PUBLIC_COLUMNS],
      excludedClasses: [
        "registered_agent_names",
        "officer_member_person_names",
        "street_postal_email_phone_contact",
        "raw_source_payloads",
        "address_hashes",
        "property_appraisal_links",
        "complaints_reviews",
      ],
      semanticScanPassed: true,
    },
    dateAvailability: {
      incorporationDate: true,
      organizationDate: false,
      dissolutionDate: false,
    },
    artifacts: [
      {
        key: "corporate-registrations/rock-island/corporate-registrations.parquet",
        bytes: 1,
        sha256:
          "a2c9e6361eda613d51010badbf5449370665c5bc8e993c4162ef327d102215a6",
        cid: parquetCid,
      },
      {
        key: "corporate-registrations/rock-island/corporate-registration-schema.json",
        bytes: 1,
        sha256:
          "048846c0f998797cb867032ea10cf4a885ce13710b11080aca9f77045432246a",
        cid: SCHEMA_CID,
      },
    ],
  };
}

/**
 * Write a two-row organization-only Parquet with the production column order.
 *
 * @param path - Destination Parquet path.
 * @param includeDriftColumn - Whether to append an unapproved source column.
 */
async function writeCorporateParquet(
  path: string,
  includeDriftColumn: boolean,
): Promise<void> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const escaped = path.replace(/'/gu, "''");
  const driftProjection = includeDriftColumn
    ? ", 'must-fail'::VARCHAR AS hidden_private_field"
    : "";
  await connection.run(`
    COPY (
      SELECT
        illinois_file_number::VARCHAR AS illinois_file_number,
        legal_company_name::VARCHAR AS legal_company_name,
        entity_type_code::VARCHAR AS entity_type_code,
        entity_type::VARCHAR AS entity_type,
        entity_status_code::VARCHAR AS entity_status_code,
        entity_status::VARCHAR AS entity_status,
        incorporation_date::VARCHAR AS incorporation_date,
        NULL::VARCHAR AS organization_date,
        NULL::VARCHAR AS dissolution_date,
        'illinois_sos'::VARCHAR AS source_system,
        '2026-07-29'::VARCHAR AS master_snapshot_date,
        '2026-07-28'::VARCHAR AS name_snapshot_date,
        '2026-07-29'::VARCHAR AS agent_snapshot_date,
        'mixed_date'::VARCHAR AS snapshot_consistency,
        99.9933::DOUBLE AS statewide_intersection_coverage_percent,
        'registered_agent_office_county'::VARCHAR AS county_scope_type,
        '081'::VARCHAR AS county_code,
        'Rock Island'::VARCHAR AS county_label
        ${driftProjection}
      FROM (
        VALUES
          ('00000001', 'SAFE COMPANY ONE LLC', 'LLC', 'Limited Liability Company', 'A', 'Active', '2020-01-02'),
          ('00000002', 'SAFE COMPANY TWO INC', 'CORP', 'Corporation', 'A', 'Active', '2019-03-04')
      ) AS fixture(
        illinois_file_number,
        legal_company_name,
        entity_type_code,
        entity_type,
        entity_status_code,
        entity_status,
        incorporation_date
      )
    ) TO '${escaped}' (FORMAT PARQUET)
  `);
}

/**
 * Send a local file with HTTP HEAD and byte-range behavior used by DuckDB httpfs.
 *
 * @param requestRange - Incoming Range header, if present.
 * @param body - Complete file bytes.
 * @param response - Node response object.
 * @param isHead - Whether the request is HEAD-only.
 */
function sendRangeFile(
  requestRange: string | undefined,
  body: Buffer,
  response: import("node:http").ServerResponse,
  isHead: boolean,
): void {
  if (isHead) {
    response.writeHead(200, {
      "Content-Length": String(body.length),
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
    });
    response.end();
    return;
  }

  const match = requestRange ? /^bytes=(\d*)-(\d*)$/u.exec(requestRange) : null;
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
    const slice = body.subarray(start, end + 1);
    response.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${body.length}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(slice.length),
      "Content-Type": "application/octet-stream",
    });
    response.end(slice);
    return;
  }

  response.writeHead(200, {
    "Content-Length": String(body.length),
    "Accept-Ranges": "bytes",
    "Content-Type": "application/octet-stream",
  });
  response.end(body);
}

describe("corporate query registration and guards", () => {
  it("registers both tools with explicit scope semantics", () => {
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

    for (const name of ["queryCorporations", "getCorporateQuerySchema"]) {
      expect(registrations.get(name)).toContain(
        "registered-agent office county",
      );
      expect(registrations.get(name)).toContain("property association/linkage");
    }
  });

  it("accepts SELECT/CTE over corporations and rejects every other relation", () => {
    expect(
      validateSelectQueryForView(
        "SELECT legal_company_name FROM corporations",
        "corporations",
      ),
    ).toMatchObject({ ok: true });
    expect(
      validateSelectQueryForView(
        "WITH active AS (SELECT * FROM corporations WHERE entity_status = 'Active') SELECT count(*) FROM active",
        "corporations",
      ),
    ).toMatchObject({ ok: true });
    expect(
      validateSelectQueryForView(
        "SELECT * FROM read_parquet('https://example.test/private.parquet')",
        "corporations",
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateSelectQueryForView("SELECT * FROM duckdb_tables", "corporations"),
    ).toMatchObject({ ok: false });
    expect(
      validateSelectQueryForView(
        "SELECT * FROM corporations; SELECT * FROM corporations",
        "corporations",
      ),
    ).toMatchObject({ ok: false });
  });

  it("fails a missing county before any data initialization", async () => {
    const result = await queryCorporationsHandler({
      county: "",
      sql: "SELECT * FROM corporations",
    });
    const parsed = parseResult(result);

    expect(parsed.error).toContain("county is required");
    expect(parsed.scopeNote).toBe(CORPORATE_SCOPE_NOTE);
  });

  it("normalizes additive routes and keeps unknown counties unserved", () => {
    const manifestUrl = "https://ipfs.filebase.io/ipns/corporate-rock-island";
    expect(
      parseCorporateManifestMapAdditions(
        JSON.stringify({ " Rock Island ": manifestUrl }),
      ),
    ).toEqual({ "rock-island": manifestUrl });

    process.env.CORPORATE_REGISTRATION_MANIFEST_MAP_ADDITIONS = JSON.stringify({
      "rock-island": manifestUrl,
    });
    try {
      expect(resolveCorporateManifestLocation("Rock Island")).toEqual({
        served: true,
        location: manifestUrl,
        countyKey: "rock-island",
      });
      expect(resolveCorporateManifestLocation("Lee")).toEqual({
        served: false,
        location: null,
        countyKey: "lee",
      });
      expect(resolveCorporateManifestLocation(undefined).served).toBe(false);
    } finally {
      delete process.env.CORPORATE_REGISTRATION_MANIFEST_MAP_ADDITIONS;
    }
  });
});

describe("corporate query cold start and schema enforcement", () => {
  const DRIFT_CID = `Qm${"1".repeat(44)}`;
  const savedEnv: Record<string, string | undefined> = {};
  let directory: string;
  let server: Server;
  let origin: string;
  let safeParquet: Buffer;
  let driftParquet: Buffer;

  beforeAll(async () => {
    for (const key of CORPORATE_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }

    directory = mkdtempSync(join(tmpdir(), "corporate-query-test-"));
    const safePath = join(directory, "safe.parquet");
    const driftPath = join(directory, "drift.parquet");
    await writeCorporateParquet(safePath, false);
    await writeCorporateParquet(driftPath, true);
    safeParquet = readFileSync(safePath);
    driftParquet = readFileSync(driftPath);

    server = createServer((request, response) => {
      if (request.url === "/ipns/safe") {
        const body = Buffer.from(JSON.stringify(buildManifest(PARQUET_CID, 2)));
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
        });
        response.end(body);
        return;
      }
      if (request.url === "/ipns/drift") {
        const body = Buffer.from(JSON.stringify(buildManifest(DRIFT_CID, 2)));
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
        });
        response.end(body);
        return;
      }
      if (request.url === `/ipfs/${PARQUET_CID}`) {
        sendRangeFile(
          request.headers.range,
          safeParquet,
          response,
          request.method === "HEAD",
        );
        return;
      }
      if (request.url === `/ipfs/${DRIFT_CID}`) {
        sendRangeFile(
          request.headers.range,
          driftParquet,
          response,
          request.method === "HEAD",
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    origin =
      `http://127.0.0.1/${(server.address() as AddressInfo).port}`.replace(
        "/127.0.0.1/",
        "/127.0.0.1:",
      );

    process.env.HOME = "";
    delete process.env.DUCKDB_HOME_DIRECTORY;
    delete process.env.CORPORATE_REGISTRATION_MANIFEST_MAP;
    delete process.env.CORPORATE_REGISTRATION_MANIFEST;
    delete process.env.CORPORATE_REGISTRATION_DEFAULT_COUNTY;
  }, 60_000);

  afterAll(async () => {
    clearCorporateQueryConnections();
    clearCorporateManifestCache();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(directory, { recursive: true, force: true });
    for (const key of CORPORATE_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("cold-starts once, caps rows, and exposes only safe fields", async () => {
    process.env.CORPORATE_REGISTRATION_MANIFEST_MAP_ADDITIONS = JSON.stringify({
      "rock-island": `${origin}/ipns/safe`,
    });
    clearCorporateQueryConnections();
    clearCorporateManifestCache();
    const createSpy = vi.spyOn(DuckDBInstance, "create");

    try {
      const [countResult, sampleResult] = await Promise.all([
        queryCorporationsHandler({
          county: "Rock Island",
          sql: "SELECT count(*) AS corporation_count FROM corporations",
        }),
        queryCorporationsHandler({
          county: "Rock Island",
          sql: "SELECT * FROM corporations ORDER BY illinois_file_number",
          limit: 1,
        }),
      ]);
      const count = parseResult(countResult);
      const sample = parseResult(sampleResult);
      const countRows = count.rows as Array<Record<string, unknown>>;
      const sampleRows = sample.rows as Array<Record<string, unknown>>;

      expect(Number(countRows[0]?.corporation_count)).toBe(2);
      expect(sample.rowCount).toBe(1);
      expect(sample.limit).toBe(1);
      expect(Object.keys(sampleRows[0] ?? {}).sort()).toEqual(
        [...CORPORATE_PUBLIC_COLUMNS].sort(),
      );
      expect(sample.scopeNote).toBe(CORPORATE_SCOPE_NOTE);
      expect(createSpy).toHaveBeenCalledTimes(1);
    } finally {
      createSpy.mockRestore();
    }
  }, 60_000);

  it("returns the exact schema and mixed-date semantics", async () => {
    const result = await getCorporateQuerySchemaHandler({
      county: "Rock Island",
    });
    const parsed = parseResult(result);
    const columns = parsed.columns as Array<{ readonly name: string }>;

    expect(columns.map((column) => column.name)).toEqual(
      CORPORATE_PUBLIC_COLUMNS,
    );
    expect(parsed.dateNote).toContain("mixed-date");
    expect(parsed.dateNote).toContain("2026-07-28");
    expect(parsed.scopeNote).toBe(CORPORATE_SCOPE_NOTE);
  }, 60_000);

  it("fails closed before exposing a Parquet with an added column", async () => {
    process.env.CORPORATE_REGISTRATION_MANIFEST_MAP_ADDITIONS = JSON.stringify({
      "rock-island": `${origin}/ipns/drift`,
    });
    clearCorporateQueryConnections();
    clearCorporateManifestCache();

    const result = await queryCorporationsHandler({
      county: "Rock Island",
      sql: "SELECT * FROM corporations",
    });
    const parsed = parseResult(result);

    expect(parsed.error).toBe("Failed to run corporate-registration query");
    expect(parsed.details).toContain(
      "source schema drifted from the exact public allowlist",
    );
    expect(parsed.scopeNote).toBe(CORPORATE_SCOPE_NOTE);
  }, 60_000);
});
