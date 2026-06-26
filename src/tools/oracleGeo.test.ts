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

const { fetchGeoIndexMock, getGeoIndexCidMock } = vi.hoisted(() => ({
  fetchGeoIndexMock: vi.fn(),
  getGeoIndexCidMock: vi.fn(),
}));

// Mock the (future) derived geo-index loader. A factory keeps this file
// loadable even before the module exists; the real handler under test must
// consume exactly this loader.
vi.mock("../lib/oracleGeoIndex.ts", () => ({
  fetchGeoIndex: fetchGeoIndexMock,
  getGeoIndexCid: getGeoIndexCidMock,
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
