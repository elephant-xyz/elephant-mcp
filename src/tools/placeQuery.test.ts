import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { DuckDBInstance } from "@duckdb/node-api";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  clearPlaceQueryCaches,
  runPlacesQuery,
  validatePublishedPlacesUrl,
} from "../lib/placeQuery.ts";
import { clearPublishedCountyCatalogCache } from "../lib/publishedCountyCatalog.ts";
import { registerAllTools } from "./registry.ts";
import {
  getPlaceQuerySchemaHandler,
  queryPlacesHandler,
} from "./placeQuery.ts";

const LIVE_LEE_ROW_COUNT = 40_191;

/**
 * Parse the first text block from an MCP tool result.
 *
 * @param result - MCP tool result with text content.
 * @returns Parsed JSON object.
 */
function parseResult(result: { content: unknown[] }): Record<string, unknown> {
  const first = result.content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("type" in first) ||
    first.type !== "text" ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    throw new Error("Expected an MCP text result");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

/**
 * Serve one in-memory buffer with HTTP range support.
 *
 * @param buffer - Complete response body.
 * @param rangeHeader - Optional HTTP Range header.
 * @returns Status, headers, and selected body.
 */
function rangeResponse(
  buffer: Buffer,
  rangeHeader: string | undefined,
): {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
} {
  const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null;
  if (match === null) {
    return {
      status: 200,
      headers: {
        "Content-Length": String(buffer.length),
        "Accept-Ranges": "bytes",
      },
      body: buffer,
    };
  }
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  let start: number;
  let end: number;
  if (startText === "") {
    const suffix = Number(endText);
    start = Math.max(0, buffer.length - suffix);
    end = buffer.length - 1;
  } else {
    start = Number(startText);
    end =
      endText === ""
        ? buffer.length - 1
        : Math.min(Number(endText), buffer.length - 1);
  }
  return {
    status: 206,
    headers: {
      "Content-Range": `bytes ${start}-${end}/${buffer.length}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
    body: buffer.subarray(start, end + 1),
  };
}

describe("published places query tools", () => {
  let directory: string;
  let parquetPath: string;
  let catalogPath: string;
  let server: Server;
  let baseUrl: string;
  let savedCatalogLocation: string | undefined;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "places-query-"));
    parquetPath = join(directory, "places-table.parquet");
    catalogPath = join(directory, "published-counties.json");

    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    await connection.run(`
      CREATE TABLE fixture_places (
        gers_id VARCHAR NOT NULL,
        county_key VARCHAR,
        county_fips VARCHAR,
        name_primary VARCHAR,
        taxonomy_primary VARCHAR,
        taxonomy_hierarchy VARCHAR,
        basic_category VARCHAR,
        legacy_category_primary VARCHAR,
        operating_status VARCHAR,
        confidence DOUBLE,
        longitude DOUBLE,
        latitude DOUBLE,
        address_freeform VARCHAR,
        address_locality VARCHAR,
        address_postcode VARCHAR,
        address_region VARCHAR,
        address_country VARCHAR,
        brand_name VARCHAR,
        brand_wikidata VARCHAR,
        is_hosted_service BOOLEAN,
        hosted_service_rule VARCHAR,
        overture_release VARCHAR,
        websites VARCHAR,
        phones VARCHAR,
        emails VARCHAR
      )
    `);
    await connection.run(`
      INSERT INTO fixture_places VALUES
        ('gers-1', 'lee', '12071', 'Sunset Nail Spa', 'nail_salon', 'shopping/beauty_and_spa/nail_salon', 'beauty_and_spa', NULL, 'open', 0.95, -81.87, 26.64, '100 Main St', 'Fort Myers', '33901', 'FL', 'US', NULL, NULL, false, NULL, '2026-07-22.0', 'https://sunset.example', '2395550001', 'hello@sunset.example'),
        ('gers-2', 'lee', '12071', 'Nails by Lee', 'nail_salon', 'shopping/beauty_and_spa/nail_salon', 'beauty_and_spa', NULL, 'open', 0.80, -81.88, 26.63, '101 Main St', 'Fort Myers', '33901', 'FL', 'US', NULL, NULL, true, 'hosted-v1', '2026-07-22.0', NULL, NULL, NULL),
        ('gers-3', 'lee', '12071', 'Bay Restaurant', 'restaurant', 'dining/restaurant/seafood_restaurant', 'restaurant', NULL, 'open', 0.90, -81.89, 26.62, '102 Main St', 'Fort Myers', '33901', 'FL', 'US', NULL, NULL, false, NULL, '2026-07-22.0', NULL, NULL, NULL),
        ('gers-4', 'lee', '12071', 'Closed Diner', 'restaurant', 'dining/restaurant/diner', 'restaurant', NULL, 'permanently_closed', 0.70, -81.95, 26.60, '200 Pine St', 'Cape Coral', '33904', 'FL', 'US', NULL, NULL, false, NULL, '2026-07-22.0', NULL, NULL, NULL),
        ('gers-5', 'lee', '12071', 'Harbor Cafe', 'cafe', 'dining/restaurant/cafe', 'restaurant', NULL, NULL, 0.60, -81.86, 26.61, '103 Main St', 'Fort Myers', '33901', 'FL', 'US', NULL, NULL, false, NULL, '2026-07-22.0', NULL, NULL, NULL),
        ('gers-6', 'lee', '12071', 'Lobby ATM', 'atm', 'services_and_business/financial_service/atm', 'financial_service', NULL, 'open', 0.50, -81.85, 26.65, '104 Main St', 'Fort Myers', '33901', 'FL', 'US', NULL, NULL, true, 'hosted-v1', '2026-07-22.0', NULL, NULL, NULL),
        ('gers-7', 'lee', '12071', 'Big Retail', 'retail_store', 'shopping/retail_store', 'retail', NULL, 'open', 0.85, -81.94, 26.59, '201 Pine St', 'Cape Coral', '33904', 'FL', 'US', NULL, NULL, false, NULL, '2026-07-22.0', NULL, NULL, NULL),
        ('gers-8', 'lee', '12071', 'ACME & Co.', NULL, NULL, NULL, NULL, 'open', NULL, -81.80, 26.34, '300 Oak St', 'Bonita Springs', '34135', 'FL', 'US', NULL, NULL, NULL, NULL, '2026-07-22.0', NULL, NULL, NULL)
    `);
    const escapedPath = parquetPath.replace(/'/g, "''");
    await connection.run(
      `COPY fixture_places TO '${escapedPath}' (FORMAT PARQUET)`,
    );
    connection.closeSync();

    const parquet = readFileSync(parquetPath);
    const index = Buffer.from(
      JSON.stringify({
        county: "lee",
        artifact: "places-table",
        rowCount: 8,
        overtureRelease: "2026-07-22.0",
        published: true,
        piiGate: "approved-test",
        attribution: {
          citation: "Overture Maps Foundation Places",
          overtureRelease: "2026-07-22.0",
          accessedDate: "2026-08-13",
          elephantChangedDate: "2026-08-13",
          themeLicence: "CDLA-Permissive-2.0 and Apache-2.0",
          foursquareCopyright:
            "Copyright 2024 Foursquare Labs, Inc. All rights reserved.",
          licenceGate: {
            passed: true,
            osmPresent: false,
            unknownDatasets: [],
            distinctDatasets: ["Overture", "Foursquare"],
          },
        },
      }),
    );
    const notice = Buffer.from("Overture Maps Foundation Places\n");

    server = createServer((request, response) => {
      if (request.url === "/lee/index.json") {
        response.writeHead(200, {
          "Content-Length": String(index.length),
          "Content-Type": "application/json",
        });
        response.end(index);
        return;
      }
      if (request.url === "/NOTICE.txt") {
        response.writeHead(200, {
          "Content-Length": String(notice.length),
          "Content-Type": "text/plain",
        });
        response.end(notice);
        return;
      }
      if (request.url !== "/lee/places-table.parquet") {
        response.writeHead(404);
        response.end();
        return;
      }
      const ranged = rangeResponse(parquet, request.headers.range);
      response.writeHead(request.method === "HEAD" ? 200 : ranged.status, {
        ...ranged.headers,
        "Content-Type": "application/vnd.apache.parquet",
      });
      response.end(request.method === "HEAD" ? undefined : ranged.body);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    writeFileSync(
      catalogPath,
      JSON.stringify({
        schemaVersion: "1.0",
        generatedAt: "2026-08-13T03:59:11.000Z",
        counties: [
          {
            countyKey: "lee",
            countyName: "Lee",
            stateCode: "FL",
            countyFips: "12071",
            status: "published",
            queryTableUrl: "https://example.com/lee-properties.parquet",
            datasetCoverageUrl: "https://example.com/lee-coverage.json",
            permitQueryTableUrl: null,
            placesTableUrl: `${baseUrl}/lee/places-table.parquet`,
            updatedAt: "2026-08-13T03:59:11.000Z",
          },
          {
            countyKey: "palm-beach",
            countyName: "Palm Beach",
            stateCode: "FL",
            countyFips: "12099",
            status: "published",
            queryTableUrl: "https://example.com/palm-beach-properties.parquet",
            datasetCoverageUrl: "https://example.com/palm-beach-coverage.json",
            permitQueryTableUrl: null,
            placesTableUrl: null,
            updatedAt: "2026-08-13T03:59:11.000Z",
          },
        ],
      }),
    );
    savedCatalogLocation = process.env.PUBLISHED_COUNTY_CATALOG_URL;
    process.env.PUBLISHED_COUNTY_CATALOG_URL = catalogPath;
    clearPublishedCountyCatalogCache();
  });

  afterAll(async () => {
    await clearPlaceQueryCaches();
    clearPublishedCountyCatalogCache();
    if (savedCatalogLocation === undefined) {
      delete process.env.PUBLISHED_COUNTY_CATALOG_URL;
    } else {
      process.env.PUBLISHED_COUNTY_CATALOG_URL = savedCatalogLocation;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(directory, { recursive: true, force: true });
  });

  it("registers and describes the exact places tool pair", () => {
    const registrations: Array<{
      readonly name: string;
      readonly description: string | undefined;
    }> = [];
    const recordingServer = {
      registerTool(
        name: string,
        definition: { readonly description?: string },
      ) {
        registrations.push({ name, description: definition.description });
      },
    };
    registerAllTools(recordingServer as unknown as McpServer);

    expect(registrations.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["queryPlaces", "getPlaceQuerySchema"]),
    );
    expect(
      registrations.find((entry) => entry.name === "queryPlaces")?.description,
    ).toMatch(/cannot provide SQL or data URLs/i);
  });

  it("returns real columns, contract, release, licence gate, and null completion", async () => {
    const payload = parseResult(
      await getPlaceQuerySchemaHandler({ county: "lee" }),
    );
    expect(payload.available).toBe(true);
    expect(payload.view).toBe("places");
    expect(payload.completionPercent).toBeUndefined();
    const columns = payload.columns as Array<{
      readonly name: string;
      readonly defaultProjection: boolean;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "taxonomy_primary",
        "taxonomy_hierarchy",
        "is_hosted_service",
      ]),
    );
    expect(
      columns.find((column) => column.name === "emails")?.defaultProjection,
    ).toBe(false);
    const provenance = payload.provenance as {
      readonly completionPercent: null;
      readonly publication: {
        readonly rowCount: number;
        readonly overtureRelease: string;
        readonly licenceGate: {
          readonly passed: boolean;
          readonly osmPresent: boolean;
        };
      };
    };
    expect(provenance.completionPercent).toBeNull();
    expect(provenance.publication).toMatchObject({
      rowCount: 8,
      overtureRelease: "2026-07-22.0",
      licenceGate: { passed: true, osmPresent: false },
    });
  });

  it("supports exact primary-category and hierarchy roll-up counts", async () => {
    const exact = await runPlacesQuery({
      county: "lee",
      mode: "count",
      filters: {
        taxonomyPrimary: { value: "nail_salon", match: "exact" },
      },
    });
    const rollup = await runPlacesQuery({
      county: "lee",
      mode: "count",
      filters: { taxonomyHierarchyMember: "restaurant" },
    });
    expect(exact.totalCount).toBe(2);
    expect(rollup.totalCount).toBe(3);
  });

  it("filters name, normalized name, locality, and postcode with bound values", async () => {
    const named = await runPlacesQuery({
      county: "lee",
      filters: {
        nameContains: "nail",
        locality: { value: "Fort Myers", match: "exact" },
        postcode: "33901",
      },
      sortBy: "name",
    });
    const normalized = await runPlacesQuery({
      county: "lee",
      mode: "count",
      filters: { normalizedNameContains: "acme co" },
    });
    expect(named.totalCount).toBe(2);
    expect(named.rowCount).toBe(2);
    expect(normalized.totalCount).toBe(1);
  });

  it("supports hosted-service, operating-status, basic-category, and confidence filters", async () => {
    const excluded = await runPlacesQuery({
      county: "lee",
      mode: "count",
      filters: { hostedService: "exclude" },
    });
    const hostedOpen = await runPlacesQuery({
      county: "lee",
      mode: "count",
      filters: {
        hostedService: "only",
        operatingStatus: "open",
      },
    });
    const confidentRestaurants = await runPlacesQuery({
      county: "lee",
      mode: "count",
      filters: {
        basicCategory: { value: "restaurant", match: "exact" },
        minConfidence: 0.65,
      },
    });
    expect(excluded.totalCount).toBe(6);
    expect(hostedOpen.totalCount).toBe(2);
    expect(confidentRestaurants.totalCount).toBe(2);
  });

  it("returns deterministic grouped aggregates", async () => {
    const grouped = await runPlacesQuery({
      county: "lee",
      mode: "groupByPrimaryCategory",
      limit: 10,
    });
    expect(grouped.totalCount).toBe(8);
    expect(grouped.totalGroups).toBe(6);
    expect(grouped.groups).toEqual([
      { taxonomyPrimary: "nail_salon", placeCount: 2 },
      { taxonomyPrimary: "restaurant", placeCount: 2 },
      { taxonomyPrimary: "atm", placeCount: 1 },
      { taxonomyPrimary: "cafe", placeCount: 1 },
      { taxonomyPrimary: "retail_store", placeCount: 1 },
      { taxonomyPrimary: null, placeCount: 1 },
    ]);
  });

  it("paginates with a deterministic sort and enforces the hard limit", async () => {
    const page = await runPlacesQuery({
      county: "lee",
      sortBy: "name",
      sortDirection: "asc",
      limit: 2,
      offset: 1,
    });
    const rows = page.rows as Array<{ readonly gers_id: string }>;
    expect(page.totalCount).toBe(8);
    expect(page.offset).toBe(1);
    expect(rows.map((row) => row.gers_id)).toEqual(["gers-3", "gers-7"]);

    const clamped = await runPlacesQuery({
      county: "lee",
      limit: 10_000,
    });
    expect(clamped.limit).toBe(1_000);
  });

  it("preserves unavailable counties as clear errors", async () => {
    const payload = parseResult(
      await queryPlacesHandler({
        county: "palm-beach",
        mode: "count",
      }),
    );
    expect(payload.error).toBe("Failed to query published places");
    expect(payload.details).toMatch(/placesTableUrl is null/);
  });

  it("binds injection-like filter text instead of treating it as SQL", async () => {
    const result = await runPlacesQuery({
      county: "lee",
      mode: "count",
      filters: { nameContains: "' OR 1=1 --" },
    });
    expect(result.totalCount).toBe(0);
  });

  it("rejects arbitrary, SSRF, traversal, and non-parquet catalog URLs", () => {
    expect(() =>
      validatePublishedPlacesUrl(
        "https://ipfs.filebase.io/ipns/name/lee/places-table.parquet",
      ),
    ).not.toThrow();
    expect(() =>
      validatePublishedPlacesUrl(
        "http://169.254.169.254/latest/meta-data/places-table.parquet",
      ),
    ).toThrow(/trusted HTTPS IPFS gateway/);
    expect(() =>
      validatePublishedPlacesUrl(
        "https://evil.example/lee/places-table.parquet",
      ),
    ).toThrow(/trusted HTTPS IPFS gateway/);
    expect(() =>
      validatePublishedPlacesUrl(
        "https://ipfs.filebase.io/ipns/name/lee/%2e%2e/places-table.parquet",
      ),
    ).toThrow(/path traversal/);
    expect(() =>
      validatePublishedPlacesUrl(
        "https://ipfs.filebase.io/ipns/name/lee/index.json",
      ),
    ).toThrow(/places-table.parquet/);
  });
});

describe.skipIf(process.env.RUN_LIVE_PLACES_TEST !== "1")(
  "live Lee published places reconciliation",
  () => {
    it("counts all 40,191 catalog-authorized Lee rows", async () => {
      const saved = process.env.PUBLISHED_COUNTY_CATALOG_URL;
      delete process.env.PUBLISHED_COUNTY_CATALOG_URL;
      clearPublishedCountyCatalogCache();
      await clearPlaceQueryCaches();
      try {
        const result = await runPlacesQuery({
          county: "lee",
          mode: "count",
        });
        expect(result.totalCount).toBe(LIVE_LEE_ROW_COUNT);
      } finally {
        if (saved === undefined) {
          delete process.env.PUBLISHED_COUNTY_CATALOG_URL;
        } else {
          process.env.PUBLISHED_COUNTY_CATALOG_URL = saved;
        }
        clearPublishedCountyCatalogCache();
        await clearPlaceQueryCaches();
      }
    }, 120_000);
  },
);
