import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { DuckDBInstance } from "@duckdb/node-api";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  clearPlaceQueryCaches,
  runPlacesQuery,
  validatePublishedPlacesUrl,
} from "../lib/placeQuery.ts";
import {
  runPlaceColocationAnalysis,
  type PlaceColocationEmbeddingRuntime,
  type PlaceColocationRequest,
} from "../lib/placeColocation.ts";
import { runPlaceColocationDiscovery } from "../lib/placeColocationDiscovery.ts";
import { clearPublishedCountyCatalogCache } from "../lib/publishedCountyCatalog.ts";
import { registerAllTools } from "./registry.ts";
import {
  placeColocationDiscoveryInputSchema,
  placeColocationInputSchema,
} from "./registry.ts";
import {
  analyzePlaceColocationHandler,
  discoverPlaceColocationCandidatesHandler,
} from "./placeColocation.ts";
import {
  getPlaceQuerySchemaHandler,
  queryPlacesHandler,
} from "./placeQuery.ts";

const LIVE_LEE_ROW_COUNT = 40_191;
const TEST_IPNS_NAME =
  "k51qzi5uqu5djfa3kbhcxedqlh7kiuyi22bd60he1nsa0wr2jrseo6vvxvwke5";
const TEST_ROOT_CID =
  "bafybeicfvfm5reer2ugipirxufpu6u3tmseoezsdfyhseysoo6p5r2mj4a";
const TEST_DIRECTORY_CID =
  "bafybeiamme7bzagrsfmqmvglnq3tzum5n76xfkbns54zu2oc3gmukffmze";
const TEST_LEAF_CID = "QmU8DpFQVWgKESeLqKPk8uFGcn8tmLWThXixib2wazBdV5";

const mockColocationEmbedMany = vi.fn(async (texts: string[]) =>
  texts.map((text, index) => ({
    text,
    embedding: index === 0 ? [1, 0] : [0, 1],
  })),
);
const TEST_EMBEDDING_RUNTIME: PlaceColocationEmbeddingRuntime = {
  available: true,
  provider: "openai",
  model: "test-embedding-model",
  embedMany: mockColocationEmbedMany,
};

function runTestColocation(request: PlaceColocationRequest) {
  return runPlaceColocationAnalysis(request, {
    embedding: TEST_EMBEDDING_RUNTIME,
  });
}

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
  let immutableHeadersEnabled = true;

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
        ('gers-4', 'lee', '12071', 'Closed Diner', 'restaurant', 'dining/restaurant/diner', 'restaurant', NULL, 'permanently_closed', 0.70, NULL, 26.60, '200 Pine St', 'Cape Coral', '33904', 'FL', 'US', NULL, NULL, false, NULL, '2026-07-22.0', NULL, NULL, NULL),
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
      if (request.url === `/ipns/${TEST_IPNS_NAME}/lee/index.json`) {
        response.writeHead(200, {
          "Content-Length": String(index.length),
          "Content-Type": "application/json",
        });
        response.end(index);
        return;
      }
      if (request.url === `/ipns/${TEST_IPNS_NAME}/NOTICE.txt`) {
        response.writeHead(200, {
          "Content-Length": String(notice.length),
          "Content-Type": "text/plain",
        });
        response.end(notice);
        return;
      }
      const mutableTablePath = `/ipns/${TEST_IPNS_NAME}/lee/places-table.parquet`;
      const immutableTablePath = `/ipfs/${TEST_ROOT_CID}/lee/places-table.parquet`;
      const immutableContentPath = `/ipfs/${TEST_LEAF_CID}`;
      if (
        request.url !== mutableTablePath &&
        request.url !== immutableTablePath &&
        request.url !== immutableContentPath
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      const ranged = rangeResponse(parquet, request.headers.range);
      response.writeHead(request.method === "HEAD" ? 200 : ranged.status, {
        ...ranged.headers,
        "Content-Type": "application/vnd.apache.parquet",
        ...(request.url === mutableTablePath && immutableHeadersEnabled
          ? {
              "X-Ipfs-Path": mutableTablePath,
              "X-Ipfs-Roots": `${TEST_ROOT_CID},${TEST_DIRECTORY_CID},${TEST_LEAF_CID}`,
            }
          : {}),
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
            placesTableUrl: `${baseUrl}/ipns/${TEST_IPNS_NAME}/lee/places-table.parquet`,
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
      expect.arrayContaining([
        "queryPlaces",
        "analyzePlaceColocation",
        "discoverPlaceColocationCandidates",
        "getPlaceQuerySchema",
      ]),
    );
    expect(
      registrations.find((entry) => entry.name === "queryPlaces")?.description,
    ).toMatch(/cannot provide SQL or data URLs/i);
    expect(
      registrations.find((entry) => entry.name === "analyzePlaceColocation")
        ?.description,
    ).toMatch(/never makes a publish decision/i);
    expect(
      registrations.find(
        (entry) => entry.name === "discoverPlaceColocationCandidates",
      )?.description,
    ).toMatch(/county only/i);
  });

  it("enforces the county-only discovery input contract", () => {
    expect(
      placeColocationDiscoveryInputSchema.parse({ county: "lee" }),
    ).toEqual({ county: "lee" });
    for (const forbidden of [
      { sql: "SELECT *" },
      { gridCellSizeMeters: 800 },
      { categoryCap: 10 },
      { resultLimit: 5 },
      { alpha: 0.05 },
      { seed: "caller-seed" },
    ]) {
      expect(
        placeColocationDiscoveryInputSchema.safeParse({
          county: "lee",
          ...forbidden,
        }).success,
      ).toBe(false);
    }
  });

  it("enforces the strict co-location input contract", () => {
    const valid = {
      county: "lee",
      categoryA: "nail_salon",
      categoryB: "restaurant",
    };
    expect(placeColocationInputSchema.parse(valid)).toMatchObject({
      ...valid,
      gridCellSizeMeters: 800,
      hostedService: "exclude",
    });
    expect(
      placeColocationInputSchema.safeParse({ ...valid, sql: "SELECT *" })
        .success,
    ).toBe(false);
    expect(
      placeColocationInputSchema.safeParse({
        ...valid,
        placesTableUrl: "https://evil.example/places-table.parquet",
      }).success,
    ).toBe(false);
    expect(
      placeColocationInputSchema.safeParse({
        ...valid,
        categoryB: "nail_salon",
      }).success,
    ).toBe(false);
    expect(
      placeColocationInputSchema.safeParse({
        ...valid,
        gridCellSizeMeters: 600,
      }).success,
    ).toBe(false);
    expect(
      placeColocationInputSchema.safeParse({
        ...valid,
        minConfidence: 1.01,
      }).success,
    ).toBe(false);
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
    expect(payload.queryContract).toMatchObject({
      analyses: {
        analyzePlaceColocation: {
          unit: expect.stringMatching(/occupied fixed grid cells/i),
          permutations: 199,
          hardLimits: {
            validCoordinatePlaces: 100_000,
            occupiedCells: 20_000,
          },
        },
        discoverPlaceColocationCandidates: {
          input: "{ county } only",
          hardLimits: {
            eligibleCategories: 256,
            declaredPairs: 32_640,
            semanticFrontier: 32,
            validationFamily: 5,
          },
        },
      },
    });
  });

  it("returns deterministic county-only discovery provenance and an explicit empty family", async () => {
    const first = await runPlaceColocationDiscovery(
      { county: "lee" },
      { embedding: TEST_EMBEDDING_RUNTIME },
    );
    const repeated = await runPlaceColocationDiscovery(
      { county: "Lee" },
      { embedding: TEST_EMBEDDING_RUNTIME },
    );

    expect(repeated.seed).toBe(first.seed);
    expect(repeated.counts).toEqual(first.counts);
    expect(first).toMatchObject({
      county: {
        key: "lee",
        stateCode: "FL",
        fips: "12071",
      },
      universe: {
        hostedService: "exclude",
        occupiedCells: 5,
      },
      provenance: {
        source: "Overture Maps Foundation Places",
        catalogUpdatedAt: "2026-08-13T03:59:11.000Z",
        completionPercent: null,
        releaseIdentity: expect.stringContaining(
          "min=2026-07-22.0;max=2026-07-22.0",
        ),
      },
      counts: {
        eligibleCategories: 0,
        declaredPairFrontier: 0,
        validationFamilyPairs: 0,
      },
      failure: {
        failedClosed: true,
        truncated: false,
      },
    });
    expect(first.failure.reason).toMatch(/Fewer than two categories/);
    expect(first.decisionNote).toMatch(/no publish decision/i);
  });

  it("keeps analyzer evidence diagnostic and fails discovery publication closed without immutable headers", async () => {
    immutableHeadersEnabled = false;
    try {
      const [analysis, discovery] = await Promise.all([
        runTestColocation({
          county: "lee",
          categoryA: "nail_salon",
          categoryB: "restaurant",
        }),
        runPlaceColocationDiscovery(
          { county: "lee" },
          { embedding: TEST_EMBEDDING_RUNTIME },
        ),
      ]);

      expect(analysis.provenance.immutablePlacesTable).toMatchObject({
        status: "unavailable",
        publishable: false,
        immutableTableUrl: null,
      });
      expect(analysis.rerunContract).toMatch(/Exact rerun is unavailable/);
      expect(analysis.decisionNote).toMatch(/non-publishable/);
      expect(discovery.failure).toMatchObject({
        failedClosed: true,
        truncated: false,
      });
      expect(discovery.failure.reason).toMatch(
        /Immutable places-table provenance is unavailable/,
      );
    } finally {
      immutableHeadersEnabled = true;
    }
  });

  it("returns pair-order-symmetric bounded co-location evidence", async () => {
    const forward = await runTestColocation({
      county: "lee",
      categoryA: "nail_salon",
      categoryB: "restaurant",
    });
    const reversed = await runTestColocation({
      county: "lee",
      categoryA: "restaurant",
      categoryB: "nail_salon",
    });

    expect(reversed).toEqual(forward);
    expect(forward.inputs).toMatchObject({
      county: "lee",
      categoryA: "nail_salon",
      categoryB: "restaurant",
      gridCellSizeMeters: 800,
      hostedService: "exclude",
    });
    expect(forward.universe).toMatchObject({
      unit: "occupied fixed grid cells",
      totalFilteredPlaces: 6,
      validCoordinatePlaces: 5,
      coordinateCoverage: 5 / 6,
    });
    expect(forward.categories.a).toMatchObject({
      id: "nail_salon",
      totalPlaces: 1,
      coordinatePlaces: 1,
      coordinateCoverage: 1,
      hierarchy: {
        path: "shopping/beauty_and_spa/nail_salon",
        supportCount: 1,
        coverage: 1,
        ambiguityCount: 0,
      },
    });
    expect(forward.categories.b).toMatchObject({
      id: "restaurant",
      totalPlaces: 2,
      coordinatePlaces: 1,
      coordinateCoverage: 0.5,
      hierarchy: {
        path: "dining/restaurant/seafood_restaurant",
        supportCount: 1,
        coverage: 1,
        ambiguityCount: 0,
      },
    });
    expect(forward.taxonomyDistance).toMatchObject({
      value: 1,
      version: "taxonomy-longest-common-prefix-v1",
    });
    expect(forward.semanticDistance).toMatchObject({
      value: 1,
      reason: null,
      provider: "openai",
      model: "test-embedding-model",
      glossVersion: "category-label-hierarchy-gloss-v1",
      glossInputs: {
        categoryA:
          "Overture category label: nail salon. Full taxonomy hierarchy: shopping/beauty_and_spa/nail_salon.",
        categoryB:
          "Overture category label: restaurant. Full taxonomy hierarchy: dining/restaurant/seafood_restaurant.",
      },
      dimensions: 2,
    });
    expect(forward.semanticDistance.vectorHashes.categoryA).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(forward.semanticDistance.vectorHashes.categoryB).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(forward.semanticCalibration).toMatchObject({
      empiricalPercentile: null,
      discoverySourceRequiredForClassH: true,
      reason: expect.stringMatching(/complete eligible category universe/i),
    });
    expect(forward.densityConditionedNull.permutations).toBe(199);
    expect(forward.densityConditionedNull.seed).toMatch(/^[a-f0-9]{64}$/);
    expect(forward.decisionNote).toMatch(/does not apply/i);
  });

  it("preserves spatial and taxonomy evidence when semantic embedding fails", async () => {
    const evidence = await runPlaceColocationAnalysis(
      {
        county: "lee",
        categoryA: "nail_salon",
        categoryB: "restaurant",
      },
      {
        embedding: {
          available: true,
          provider: "bedrock",
          model: "test-failing-model",
          embedMany: async () => {
            throw new Error("credentials unavailable");
          },
        },
      },
    );

    expect(evidence.universe).toMatchObject({
      totalFilteredPlaces: 6,
      validCoordinatePlaces: 5,
    });
    expect(evidence.observed.jointCells).toBeTypeOf("number");
    expect(evidence.taxonomyDistance.value).toBe(1);
    expect(evidence.semanticDistance).toMatchObject({
      value: null,
      reason: "Semantic embedding failed: credentials unavailable",
      provider: "bedrock",
      model: "test-failing-model",
      dimensions: null,
      vectorHashes: {
        categoryA: null,
        categoryB: null,
      },
    });
  });

  it("aborts analyzer DuckDB work before execution when requested", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runPlaceColocationAnalysis(
        {
          county: "lee",
          categoryA: "nail_salon",
          categoryB: "restaurant",
        },
        {
          embedding: TEST_EMBEDDING_RUNTIME,
          abortSignal: controller.signal,
        },
      ),
    ).rejects.toThrow(/Places query was aborted before execution/);
  });

  it("applies hosted-service defaults and optional status/confidence filters to the entire universe", async () => {
    const included = await runTestColocation({
      county: "lee",
      categoryA: "nail_salon",
      categoryB: "restaurant",
      hostedService: "include",
    });
    const filtered = await runTestColocation({
      county: "lee",
      categoryA: "nail_salon",
      categoryB: "restaurant",
      operatingStatus: "open",
      minConfidence: 0.85,
    });

    expect(included.universe).toMatchObject({
      totalFilteredPlaces: 8,
      validCoordinatePlaces: 7,
    });
    expect(included.categories.a).toMatchObject({
      totalPlaces: 2,
      coordinatePlaces: 2,
    });
    expect(filtered.universe).toMatchObject({
      totalFilteredPlaces: 3,
      validCoordinatePlaces: 3,
      coordinateCoverage: 1,
    });
    expect(filtered.categories.a.totalPlaces).toBe(1);
    expect(filtered.categories.b.totalPlaces).toBe(1);
  });

  it("preserves release, licence, catalog, completion, and source provenance", async () => {
    const evidence = await runTestColocation({
      county: "lee",
      categoryA: "nail_salon",
      categoryB: "restaurant",
    });
    expect(evidence.provenance).toMatchObject({
      source: "Overture Maps Foundation Places",
      catalogUpdatedAt: "2026-08-13T03:59:11.000Z",
      completionPercent: null,
      publication: {
        overtureRelease: "2026-07-22.0",
        themeLicence: "CDLA-Permissive-2.0 and Apache-2.0",
        licenceGate: { passed: true },
      },
    });
    expect(evidence.provenance.placesTableUrl).toBe(
      `${baseUrl}/ipns/${TEST_IPNS_NAME}/lee/places-table.parquet`,
    );
    expect(evidence.provenance.immutablePlacesTable).toMatchObject({
      status: "resolved",
      publishable: true,
      rootCid: TEST_ROOT_CID,
      contentCid: TEST_LEAF_CID,
      immutableTableUrl: `${baseUrl}/ipfs/${TEST_ROOT_CID}/lee/places-table.parquet`,
      immutableContentUrl: `${baseUrl}/ipfs/${TEST_LEAF_CID}`,
    });
    expect(evidence.provenance.publicationIndexUrl).toBe(
      `${baseUrl}/ipns/${TEST_IPNS_NAME}/lee/index.json`,
    );
    expect(evidence.provenance.noticeUrl).toBe(
      `${baseUrl}/ipns/${TEST_IPNS_NAME}/NOTICE.txt`,
    );
    expect(evidence.provenance.releaseIdentity).toContain(
      `rootCid=${TEST_ROOT_CID};contentCid=${TEST_LEAF_CID}`,
    );
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

    const colocationPayload = parseResult(
      await analyzePlaceColocationHandler({
        county: "palm-beach",
        categoryA: "nail_salon",
        categoryB: "restaurant",
      }),
    );
    expect(colocationPayload.error).toBe(
      "Failed to analyze published place co-location",
    );
    expect(colocationPayload.details).toMatch(/placesTableUrl is null/);
  });

  it("fails closed when the canonical catalog is unavailable", async () => {
    process.env.PUBLISHED_COUNTY_CATALOG_URL = join(
      directory,
      "missing-catalog.json",
    );
    clearPublishedCountyCatalogCache();
    try {
      const payload = parseResult(
        await analyzePlaceColocationHandler({
          county: "lee",
          categoryA: "nail_salon",
          categoryB: "restaurant",
        }),
      );
      expect(payload.error).toBe(
        "Failed to analyze published place co-location",
      );
      expect(payload.details).toMatch(/ENOENT|no such file/i);
    } finally {
      process.env.PUBLISHED_COUNTY_CATALOG_URL = catalogPath;
      clearPublishedCountyCatalogCache();
    }
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
        "https://ipfs.filebase.io/ipns/name/lee/../places-table.parquet",
      ),
    ).toThrow(/path traversal/);
    expect(() =>
      validatePublishedPlacesUrl(
        "https://ipfs.filebase.io/ipns/name/lee%2fhidden/places-table.parquet",
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

    it.each([
      {
        categoryA: "marina",
        categoryB: "seafood_restaurant",
      },
      {
        categoryA: "fishing_charter",
        categoryB: "marina",
      },
    ])(
      "runs live semantic canary for $categoryA + $categoryB",
      async ({ categoryA, categoryB }) => {
        const saved = process.env.PUBLISHED_COUNTY_CATALOG_URL;
        delete process.env.PUBLISHED_COUNTY_CATALOG_URL;
        clearPublishedCountyCatalogCache();
        await clearPlaceQueryCaches();
        try {
          const evidence = await runPlaceColocationAnalysis({
            county: "lee",
            categoryA,
            categoryB,
          });
          console.info(
            JSON.stringify({
              canary: `${categoryA}+${categoryB}`,
              jointCells: evidence.observed.jointCells,
              globalLift: evidence.observed.globalLift,
              conditionedPValue: evidence.densityConditionedNull.pValue,
              taxonomyDistance: evidence.taxonomyDistance.value,
              semanticDistance: evidence.semanticDistance,
            }),
          );
          expect(evidence.inputs).toMatchObject({
            categoryA: [categoryA, categoryB].sort()[0],
            categoryB: [categoryA, categoryB].sort()[1],
          });
        } finally {
          if (saved === undefined) {
            delete process.env.PUBLISHED_COUNTY_CATALOG_URL;
          } else {
            process.env.PUBLISHED_COUNTY_CATALOG_URL = saved;
          }
          clearPublishedCountyCatalogCache();
          await clearPlaceQueryCaches();
        }
      },
      120_000,
    );
  },
);

describe.skipIf(process.env.RUN_LIVE_PLACE_DISCOVERY !== "1")(
  "live Lee place co-location discovery",
  () => {
    it("completes the real county-only tool canary within the 120-second web budget", async () => {
      delete process.env.PUBLISHED_COUNTY_CATALOG_URL;
      clearPublishedCountyCatalogCache();
      await clearPlaceQueryCaches();
      const startedAt = performance.now();
      try {
        const payload = parseResult(
          await discoverPlaceColocationCandidatesHandler({
            county: "lee",
          }),
        );
        const elapsedMilliseconds = Math.round(performance.now() - startedAt);
        console.info(
          JSON.stringify({
            canary: "live-lee-place-colocation-discovery",
            elapsedMilliseconds,
            county: payload.county,
            universe: payload.universe,
            counts: payload.counts,
            failure: payload.failure,
            semanticAudit: payload.semanticAudit,
            semanticFrontier: (
              payload.semanticFrontier as
                | Array<Record<string, unknown>>
                | undefined
            )?.map((entry) => ({
              rank: entry.rank,
              categoryA: (
                entry.categoryA as Record<string, unknown> | undefined
              )?.id,
              categoryB: (
                entry.categoryB as Record<string, unknown> | undefined
              )?.id,
              semanticDistance: (
                entry.semantic as Record<string, unknown> | undefined
              )?.value,
              semanticPercentile: (
                entry.semantic as Record<string, unknown> | undefined
              )?.empiricalPercentile,
              semanticPassed: (
                entry.semantic as Record<string, unknown> | undefined
              )?.passed,
            })),
            validationFamily: (
              payload.validationFamily as
                | Array<Record<string, unknown>>
                | undefined
            )?.map((entry) => ({
              discoveryRank: entry.discoveryRank,
              categoryA: (
                entry.categoryA as Record<string, unknown> | undefined
              )?.id,
              categoryB: (
                entry.categoryB as Record<string, unknown> | undefined
              )?.id,
              semanticDistance: (
                entry.semantic as Record<string, unknown> | undefined
              )?.value,
              semanticPercentile: (
                entry.semantic as Record<string, unknown> | undefined
              )?.empiricalPercentile,
              validation: {
                jointCells: (
                  entry.validation as Record<string, unknown> | undefined
                )?.jointCells,
                rawLift: (
                  entry.validation as Record<string, unknown> | undefined
                )?.rawLift,
                guards: (
                  entry.validation as Record<string, unknown> | undefined
                )?.guards,
                null: (entry.validation as Record<string, unknown> | undefined)
                  ?.null,
              },
              fullUniverse: {
                jointCells: (
                  entry.fullUniverse as Record<string, unknown> | undefined
                )?.jointCells,
                rawLift: (
                  entry.fullUniverse as Record<string, unknown> | undefined
                )?.rawLift,
                magnitudeFloor: (
                  entry.fullUniverse as Record<string, unknown> | undefined
                )?.magnitudeFloor,
                guards: (
                  entry.fullUniverse as Record<string, unknown> | undefined
                )?.guards,
              },
            })),
          }),
        );
        expect(payload.error).toBeUndefined();
        expect(elapsedMilliseconds).toBeLessThan(120_000);
        expect(payload.universe).toMatchObject({
          hostedService: "exclude",
        });
        const controls = await Promise.all(
          [
            ["convenience_store", "gas_station"],
            ["hair_salon", "nail_salon"],
            ["marina", "seafood_restaurant"],
            ["fishing_charter", "marina"],
          ].map(async ([categoryA, categoryB]) => {
            const evidence = parseResult(
              await analyzePlaceColocationHandler({
                county: "lee",
                categoryA: categoryA!,
                categoryB: categoryB!,
              }),
            );
            return {
              categoryA,
              categoryB,
              semanticDistance: (
                evidence.semanticDistance as Record<string, unknown>
              ).value,
              calibratedPercentile: (
                evidence.semanticCalibration as Record<string, unknown>
              ).empiricalPercentile,
            };
          }),
        );
        console.info(
          JSON.stringify({
            canary: "live-lee-semantic-controls",
            controls,
          }),
        );
        for (const control of controls) {
          expect(control.semanticDistance).toBeLessThan(0.35);
          expect(control.calibratedPercentile).toBeNull();
        }
      } finally {
        clearPublishedCountyCatalogCache();
        await clearPlaceQueryCaches();
      }
    }, 180_000);

    it("repeats immutable Lee candidates and audit digests deterministically", async () => {
      delete process.env.PUBLISHED_COUNTY_CATALOG_URL;
      clearPublishedCountyCatalogCache();
      await clearPlaceQueryCaches();
      try {
        const firstStartedAt = performance.now();
        const first = await runPlaceColocationDiscovery(
          { county: "lee" },
          { embedding: TEST_EMBEDDING_RUNTIME },
        );
        const firstElapsedMilliseconds = Math.round(
          performance.now() - firstStartedAt,
        );
        const repeatedStartedAt = performance.now();
        const repeated = await runPlaceColocationDiscovery(
          { county: "lee" },
          { embedding: TEST_EMBEDDING_RUNTIME },
        );
        const repeatedElapsedMilliseconds = Math.round(
          performance.now() - repeatedStartedAt,
        );
        const candidates = first.semanticFrontier.map((entry) => [
          entry.categoryA.id,
          entry.categoryB.id,
        ]);
        console.info(
          JSON.stringify({
            canary: "live-lee-immutable-provenance-repeat",
            firstElapsedMilliseconds,
            repeatedElapsedMilliseconds,
            immutablePlacesTable: first.provenance.immutablePlacesTable,
            seed: first.seed,
            candidates,
            auditDigests: {
              corpus: first.semanticAudit.corpus.digest,
              referenceDistribution:
                first.semanticAudit.referenceDistribution.digest,
              spatialLedger: first.semanticAudit.spatialLedger.digest,
            },
          }),
        );
        expect(firstElapsedMilliseconds).toBeLessThan(120_000);
        expect(repeatedElapsedMilliseconds).toBeLessThan(120_000);
        expect(first.provenance.immutablePlacesTable).toMatchObject({
          status: "resolved",
          publishable: true,
          rootCid: expect.any(String),
          immutableTableUrl: expect.stringContaining("/ipfs/"),
        });
        expect(repeated.seed).toBe(first.seed);
        expect(
          repeated.semanticFrontier.map((entry) => [
            entry.categoryA.id,
            entry.categoryB.id,
          ]),
        ).toEqual(candidates);
        expect(repeated.semanticAudit).toEqual(first.semanticAudit);
      } finally {
        clearPublishedCountyCatalogCache();
        await clearPlaceQueryCaches();
      }
    }, 240_000);
  },
);
