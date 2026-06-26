/**
 * Story 3 — geo/value: code-review-sentinel BLOCKER regression tests.
 *
 * These tests are GREEN regression guards: the handlers in `./oracleGeo.ts`
 * ship in this PR and satisfy every blocker below. They lock the behaviour in
 * place so a future change can't silently reintroduce a blocker. They encode
 * the reviewer's blockers, NOT new scope.
 *
 * Blockers guarded here (consumer / MCP side):
 *  3. Silent invalid area input — a request with NO bbox and NO polygon, an
 *     invalid polygon (< 3 vertices), or an inverted bbox (minLat > maxLat or
 *     minLng > maxLng) MUST surface an explicit error rather than silently
 *     returning count = 0, which is indistinguishable from "a valid area that
 *     contains nothing".
 *  5. findPropertiesInArea output MUST include the folio validation key for each
 *     in-area parcel.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { fetchGeoIndexMock, getGeoIndexCidMock } = vi.hoisted(() => ({
  fetchGeoIndexMock: vi.fn(),
  getGeoIndexCidMock: vi.fn(),
}));

vi.mock("../lib/oracleGeoIndex.ts", () => ({
  fetchGeoIndex: fetchGeoIndexMock,
  getGeoIndexCid: getGeoIndexCidMock,
}));

const GEO_INDEX = {
  county: "Lee",
  entries: [
    {
      parcelIdentifier: "P-INSIDE-1",
      requestIdentifier: "REQ-1",
      folio: "0000000001",
      latitude: 5,
      longitude: 5,
      currentAvmValue: 100_000,
      propertyType: "COMMERCIAL",
    },
    {
      parcelIdentifier: "P-INSIDE-2",
      requestIdentifier: "REQ-2",
      folio: "0000000002",
      latitude: 2,
      longitude: 8,
      currentAvmValue: 250_000,
      propertyType: "COMMERCIAL",
    },
  ],
};

const BBOX = { minLat: 0, minLng: 0, maxLat: 10, maxLng: 10 };

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Blocker 3 — invalid / missing area must error, not silently return count 0
// ---------------------------------------------------------------------------
describe("findPropertiesInAreaHandler — invalid area input is an explicit error (blocker 3, red)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchGeoIndexMock.mockResolvedValue(GEO_INDEX);
    getGeoIndexCidMock.mockReturnValue("QmGeoIndexCid");
  });

  it("returns an explicit error when neither bbox nor polygon is provided", async () => {
    const { findPropertiesInAreaHandler } = await import("./oracleGeo.ts");
    const parsed = parse(await findPropertiesInAreaHandler({}));
    expect(parsed.error).toBeTruthy();
    // Must NOT masquerade as a valid-but-empty area.
    expect(parsed.count).toBeUndefined();
  });

  it("returns an explicit error for a degenerate polygon with fewer than 3 vertices", async () => {
    const { findPropertiesInAreaHandler } = await import("./oracleGeo.ts");
    const parsed = parse(
      await findPropertiesInAreaHandler({
        polygon: [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 10 },
        ],
      }),
    );
    expect(parsed.error).toBeTruthy();
    expect(parsed.count).toBeUndefined();
  });
});

describe("sumPropertyValueInAreaHandler — invalid area input is an explicit error (blocker 3, red)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchGeoIndexMock.mockResolvedValue(GEO_INDEX);
    getGeoIndexCidMock.mockReturnValue("QmGeoIndexCid");
  });

  it("returns an explicit error when neither bbox nor polygon is provided", async () => {
    const { sumPropertyValueInAreaHandler } = await import("./oracleGeo.ts");
    const parsed = parse(await sumPropertyValueInAreaHandler({}));
    expect(parsed.error).toBeTruthy();
    // A genuine zero total over a valid area is a different outcome; a missing
    // area must not silently report totalValue 0.
    expect(parsed.totalValue).toBeUndefined();
  });

  it("returns an explicit error for a degenerate polygon with fewer than 3 vertices", async () => {
    const { sumPropertyValueInAreaHandler } = await import("./oracleGeo.ts");
    const parsed = parse(
      await sumPropertyValueInAreaHandler({
        polygon: [{ lat: 0, lng: 0 }],
      }),
    );
    expect(parsed.error).toBeTruthy();
    expect(parsed.totalValue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Blocker 3 (cont.) — an inverted bbox must error, not silently return count 0
// ---------------------------------------------------------------------------
const INVERTED_BBOX = { minLat: 30, maxLat: 20, minLng: -82, maxLng: -82 };

describe("inverted bbox is an explicit error, not a silent count 0 (blocker 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchGeoIndexMock.mockResolvedValue(GEO_INDEX);
    getGeoIndexCidMock.mockReturnValue("QmGeoIndexCid");
  });

  it("findPropertiesInAreaHandler errors for an inverted bbox", async () => {
    const { findPropertiesInAreaHandler } = await import("./oracleGeo.ts");
    const parsed = parse(
      await findPropertiesInAreaHandler({ bbox: INVERTED_BBOX }),
    );
    expect(parsed.error).toBeTruthy();
    expect(parsed.count).toBeUndefined();
  });

  it("sumPropertyValueInAreaHandler errors for an inverted bbox", async () => {
    const { sumPropertyValueInAreaHandler } = await import("./oracleGeo.ts");
    const parsed = parse(
      await sumPropertyValueInAreaHandler({ bbox: INVERTED_BBOX }),
    );
    expect(parsed.error).toBeTruthy();
    expect(parsed.totalValue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Blocker 5 — folio must be present on each parcel in the output
// ---------------------------------------------------------------------------
describe("findPropertiesInAreaHandler — folio in output (blocker 5, red)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchGeoIndexMock.mockResolvedValue(GEO_INDEX);
    getGeoIndexCidMock.mockReturnValue("QmGeoIndexCid");
  });

  it("includes the folio validation key for each in-area parcel", async () => {
    const { findPropertiesInAreaHandler } = await import("./oracleGeo.ts");
    const parsed = parse(await findPropertiesInAreaHandler({ bbox: BBOX }));

    expect(parsed.count).toBe(2);
    const byParcel = new Map<string, string>(
      parsed.parcels.map((p: { parcelIdentifier: string; folio: string }) => [
        p.parcelIdentifier,
        p.folio,
      ]),
    );
    expect(byParcel.get("P-INSIDE-1")).toBe("0000000001");
    expect(byParcel.get("P-INSIDE-2")).toBe("0000000002");
  });
});
