/**
 * Story 3 — AC1: MCP geo/value tools.
 *
 * These tests are GREEN regression guards. The handlers in `./oracleGeo.ts`
 * ship in this PR and satisfy the contract below; the tests lock that
 * behaviour in place. They read a small derived geo index via
 * `../lib/oracleGeoIndex.ts` (mocked here) and pin:
 *  - findPropertiesInArea(bbox|polygon) → the set of parcels whose centroid
 *    falls inside the area, plus a count.
 *  - sumPropertyValueInArea(bbox|polygon) → the EXACT sum of current_avm_value
 *    over the in-area parcels.
 *
 * Scope fences encoded here:
 *  - Area input is a user-supplied bbox or polygon of coords; centroid lat/lng
 *    is enough. No NOAA/FEMA geometry, no PostGIS.
 *  - The geo index is a SEPARATE derived index (mocked here as
 *    ../lib/oracleGeoIndex.ts), not the consolidated open-data manifest.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  fetchGeoIndexMock,
  getGeoIndexCidMock,
  isCountyServedMock,
  runInternalPropertyQueryMock,
  resolveDefaultQueryTableCountyMock,
} = vi.hoisted(() => ({
  fetchGeoIndexMock: vi.fn(),
  getGeoIndexCidMock: vi.fn(),
  isCountyServedMock: vi.fn(),
  runInternalPropertyQueryMock: vi.fn(),
  resolveDefaultQueryTableCountyMock: vi.fn(),
}));

// Mock the (future) derived geo-index loader. A factory keeps this file
// loadable even before the module exists; the real handler under test must
// consume exactly this loader.
vi.mock("../lib/oracleGeoIndex.ts", () => ({
  fetchGeoIndex: fetchGeoIndexMock,
  getGeoIndexCid: getGeoIndexCidMock,
}));

// Mock the query-table layer so we can drive the PRIMARY path (served) and the
// FALLBACK path (not served → geo index) independently.
vi.mock("../lib/duckdbQuery.ts", () => ({
  isCountyServedByQueryTable: isCountyServedMock,
  runInternalPropertyQuery: runInternalPropertyQueryMock,
  resolveDefaultQueryTableCounty: resolveDefaultQueryTableCountyMock,
  PROPERTIES_VIEW: "properties",
}));

// A small derived geo index: per-parcel centroid + current AVM value + type.
// Coordinates chosen so membership in the test areas is unambiguous.
const GEO_INDEX = {
  county: "Lee",
  entries: [
    {
      parcelIdentifier: "P-INSIDE-1",
      requestIdentifier: "REQ-1",
      latitude: 5,
      longitude: 5,
      currentAvmValue: 100_000,
      propertyType: "COMMERCIAL",
    },
    {
      parcelIdentifier: "P-INSIDE-2",
      requestIdentifier: "REQ-2",
      latitude: 2,
      longitude: 8,
      currentAvmValue: 250_000,
      propertyType: "COMMERCIAL",
    },
    {
      // inside the area but has no valuation — must not break the sum
      parcelIdentifier: "P-INSIDE-NULLVAL",
      requestIdentifier: "REQ-3",
      latitude: 9,
      longitude: 1,
      currentAvmValue: null,
      propertyType: "RESIDENTIAL",
    },
    {
      parcelIdentifier: "P-OUTSIDE-1",
      requestIdentifier: "REQ-4",
      latitude: 50,
      longitude: 50,
      currentAvmValue: 999_999,
      propertyType: "COMMERCIAL",
    },
    {
      parcelIdentifier: "P-OUTSIDE-2",
      requestIdentifier: "REQ-5",
      latitude: -5,
      longitude: -5,
      currentAvmValue: 12_345,
      propertyType: "COMMERCIAL",
    },
  ],
};

// bbox covering the lower-left square [0,10] x [0,10]
const BBOX = { minLat: 0, minLng: 0, maxLat: 10, maxLng: 10 };

// the same square expressed as a polygon ring of coords
const POLYGON = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 10 },
  { lat: 10, lng: 10 },
  { lat: 10, lng: 0 },
];

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("findPropertiesInAreaHandler (red — tool not implemented)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchGeoIndexMock.mockResolvedValue(GEO_INDEX);
    getGeoIndexCidMock.mockReturnValue("QmGeoIndexCid");
  });

  it("returns exactly the parcels whose centroid is inside the bbox", async () => {
    const { findPropertiesInAreaHandler } = await import("./oracleGeo.ts");

    const result = await findPropertiesInAreaHandler({ bbox: BBOX });
    const parsed = parse(result);

    expect(parsed.count).toBe(3);
    expect(
      new Set(
        parsed.parcels.map(
          (p: { parcelIdentifier: string }) => p.parcelIdentifier,
        ),
      ),
    ).toEqual(new Set(["P-INSIDE-1", "P-INSIDE-2", "P-INSIDE-NULLVAL"]));
  });

  it("excludes parcels whose centroid is outside the bbox", async () => {
    const { findPropertiesInAreaHandler } = await import("./oracleGeo.ts");

    const result = await findPropertiesInAreaHandler({ bbox: BBOX });
    const parsed = parse(result);

    const ids = parsed.parcels.map(
      (p: { parcelIdentifier: string }) => p.parcelIdentifier,
    );
    expect(ids).not.toContain("P-OUTSIDE-1");
    expect(ids).not.toContain("P-OUTSIDE-2");
  });

  it("supports a polygon of coords (point-in-polygon), not just a bbox", async () => {
    const { findPropertiesInAreaHandler } = await import("./oracleGeo.ts");

    const result = await findPropertiesInAreaHandler({ polygon: POLYGON });
    const parsed = parse(result);

    expect(parsed.count).toBe(3);
    expect(
      new Set(
        parsed.parcels.map(
          (p: { parcelIdentifier: string }) => p.parcelIdentifier,
        ),
      ),
    ).toEqual(new Set(["P-INSIDE-1", "P-INSIDE-2", "P-INSIDE-NULLVAL"]));
  });

  it("returns an empty set when no parcel centroid falls in the area", async () => {
    const { findPropertiesInAreaHandler } = await import("./oracleGeo.ts");

    const result = await findPropertiesInAreaHandler({
      bbox: { minLat: 100, minLng: 100, maxLat: 110, maxLng: 110 },
    });
    const parsed = parse(result);

    expect(parsed.count).toBe(0);
    expect(parsed.parcels).toHaveLength(0);
  });
});

describe("sumPropertyValueInAreaHandler (red — tool not implemented)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchGeoIndexMock.mockResolvedValue(GEO_INDEX);
    getGeoIndexCidMock.mockReturnValue("QmGeoIndexCid");
  });

  it("sums current_avm_value over exactly the in-area parcels (bbox)", async () => {
    const { sumPropertyValueInAreaHandler } = await import("./oracleGeo.ts");

    const result = await sumPropertyValueInAreaHandler({ bbox: BBOX });
    const parsed = parse(result);

    // 100_000 + 250_000 + (null → 0) = 350_000
    expect(parsed.totalValue).toBe(350_000);
    expect(parsed.count).toBe(3);
  });

  it("sums current_avm_value over the polygon area (coords)", async () => {
    const { sumPropertyValueInAreaHandler } = await import("./oracleGeo.ts");

    const result = await sumPropertyValueInAreaHandler({ polygon: POLYGON });
    const parsed = parse(result);

    expect(parsed.totalValue).toBe(350_000);
  });

  it("does not include the value of parcels outside the area", async () => {
    const { sumPropertyValueInAreaHandler } = await import("./oracleGeo.ts");

    const result = await sumPropertyValueInAreaHandler({ bbox: BBOX });
    const parsed = parse(result);

    // 999_999 (P-OUTSIDE-1) and 12_345 (P-OUTSIDE-2) must NOT be counted.
    expect(parsed.totalValue).not.toBe(350_000 + 999_999 + 12_345);
    expect(parsed.totalValue).toBe(350_000);
  });

  it("returns zero for an empty area", async () => {
    const { sumPropertyValueInAreaHandler } = await import("./oracleGeo.ts");

    const result = await sumPropertyValueInAreaHandler({
      bbox: { minLat: 100, minLng: 100, maxLat: 110, maxLng: 110 },
    });
    const parsed = parse(result);

    expect(parsed.totalValue).toBe(0);
    expect(parsed.count).toBe(0);
  });
});

// === Query-table PRIMARY path ===
describe("geo tools over the query table (primary path)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    isCountyServedMock.mockReturnValue(true);
    resolveDefaultQueryTableCountyMock.mockReturnValue(null);
  });

  it("[find] bbox becomes a SQL BETWEEN filter and returns the shaped parcels", async () => {
    runInternalPropertyQueryMock.mockResolvedValue([
      {
        parcel_identifier: "P-1",
        request_identifier: "REQ-1",
        latitude: 5,
        longitude: 5,
        avm_value: 100_000,
        property_type: "COMMERCIAL",
      },
    ]);
    const { findPropertiesInAreaHandler } = await import("./oracleGeo.ts");

    const result = await findPropertiesInAreaHandler({
      bbox: BBOX,
      county: "Lee",
    });
    const parsed = parse(result);

    // Fallback geo index is never consulted.
    expect(fetchGeoIndexMock).not.toHaveBeenCalled();
    const [county, sql, params] = runInternalPropertyQueryMock.mock.calls[0];
    expect(county).toBe("Lee");
    expect(sql).toContain("latitude BETWEEN $1 AND $2");
    expect(sql).toContain("longitude BETWEEN $3 AND $4");
    expect(params).toEqual([0, 10, 0, 10]);
    expect(parsed.count).toBe(1);
    expect(parsed.parcels[0]).toMatchObject({
      parcelIdentifier: "P-1",
      requestIdentifier: "REQ-1",
      latitude: 5,
      longitude: 5,
      currentAvmValue: 100_000,
      propertyType: "COMMERCIAL",
    });
  });

  it("[find] polygon pre-filters by its bbox in SQL then ray-casts survivors", async () => {
    // Triangle covering the lower-left half of the [0,10] square.
    const triangle = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 10 },
      { lat: 10, lng: 0 },
    ];
    // Both rows pass the bbox pre-filter; only the first is inside the triangle.
    runInternalPropertyQueryMock.mockResolvedValue([
      {
        parcel_identifier: "IN",
        request_identifier: "R1",
        latitude: 1,
        longitude: 1,
        avm_value: 10,
        property_type: null,
      },
      {
        parcel_identifier: "OUT",
        request_identifier: "R2",
        latitude: 9,
        longitude: 9,
        avm_value: 20,
        property_type: null,
      },
    ]);
    const { findPropertiesInAreaHandler } = await import("./oracleGeo.ts");

    const result = await findPropertiesInAreaHandler({
      polygon: triangle,
      county: "Lee",
    });
    const parsed = parse(result);

    // SQL pre-filter uses the polygon's bounding box.
    const [, , params] = runInternalPropertyQueryMock.mock.calls[0];
    expect(params).toEqual([0, 10, 0, 10]);
    // Ray-cast keeps only the point inside the triangle.
    expect(parsed.count).toBe(1);
    expect(parsed.parcels[0].parcelIdentifier).toBe("IN");
  });

  it("[sum] sums avm_value over in-area parcels (nulls → 0)", async () => {
    runInternalPropertyQueryMock.mockResolvedValue([
      {
        parcel_identifier: "A",
        request_identifier: "R1",
        latitude: 5,
        longitude: 5,
        avm_value: 100_000,
        property_type: null,
      },
      {
        parcel_identifier: "B",
        request_identifier: "R2",
        latitude: 2,
        longitude: 8,
        avm_value: 250_000,
        property_type: null,
      },
      {
        parcel_identifier: "C",
        request_identifier: "R3",
        latitude: 9,
        longitude: 1,
        avm_value: null,
        property_type: null,
      },
    ]);
    const { sumPropertyValueInAreaHandler } = await import("./oracleGeo.ts");

    const result = await sumPropertyValueInAreaHandler({
      bbox: BBOX,
      county: "Lee",
    });
    const parsed = parse(result);

    expect(parsed.totalValue).toBe(350_000);
    expect(parsed.count).toBe(3);
    expect(new Set(parsed.parcels)).toEqual(new Set(["A", "B", "C"]));
  });

  it("[find] resolves the sole served county when none is supplied", async () => {
    resolveDefaultQueryTableCountyMock.mockReturnValue("lee");
    runInternalPropertyQueryMock.mockResolvedValue([]);
    const { findPropertiesInAreaHandler } = await import("./oracleGeo.ts");

    await findPropertiesInAreaHandler({ bbox: BBOX });

    expect(runInternalPropertyQueryMock.mock.calls[0][0]).toBe("lee");
  });

  it("[find] rejects an invalid area before querying", async () => {
    const { findPropertiesInAreaHandler } = await import("./oracleGeo.ts");

    const result = await findPropertiesInAreaHandler({ county: "Lee" });
    const parsed = parse(result);

    expect(parsed.error).toContain("Invalid area");
    expect(runInternalPropertyQueryMock).not.toHaveBeenCalled();
  });
});
