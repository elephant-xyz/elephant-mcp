import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listOraclePropertiesHandler,
  getOraclePropertyHandler,
  getOracleDatasetInfoHandler,
} from "./oracleOpenData.ts";

vi.mock("../lib/ipfs.ts", () => ({
  getJsonByCid: vi.fn(),
}));

vi.mock("../lib/oracleManifest.ts", () => ({
  fetchOracleManifest: vi.fn(),
  getManifestCid: vi.fn(),
}));

const { getJsonByCid } = await import("../lib/ipfs.ts");
const { fetchOracleManifest, getManifestCid } = await import(
  "../lib/oracleManifest.ts"
);

const mockGetJsonByCid = vi.mocked(getJsonByCid);
const mockFetchOracleManifest = vi.mocked(fetchOracleManifest);
const mockGetManifestCid = vi.mocked(getManifestCid);

const buildEntry = (
  propertyId: string,
  parcelIdentifier: string,
  cid: string,
  overrides: Partial<{
    filePath: string;
    fileSizeBytes: number;
    sha256: string;
  }> = {},
) => ({
  propertyId,
  parcelIdentifier,
  filePath: overrides.filePath ?? `data/${propertyId}.json`,
  fileSizeBytes: overrides.fileSizeBytes ?? 1024,
  sha256: overrides.sha256 ?? "abc123def456",
  cid,
});

const buildManifest = (entries: ReturnType<typeof buildEntry>[]) => ({
  schemaVersion: "1.0",
  county: "Lee",
  exportedAt: "2024-06-01T00:00:00Z",
  propertyCount: entries.length,
  totalBytes: entries.reduce((s, e) => s + e.fileSizeBytes, 0),
  entries,
});

describe("listOraclePropertiesHandler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns all entries when no filter is applied", async () => {
    const entries = [
      buildEntry("uuid-001", "1234567890", "cid-001"),
      buildEntry("uuid-002", "2345678901", "cid-002"),
      buildEntry("uuid-003", "3456789012", "cid-003"),
    ];
    mockFetchOracleManifest.mockResolvedValue(buildManifest(entries));

    const result = await listOraclePropertiesHandler({});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.total).toBe(3);
    expect(parsed.offset).toBe(0);
    expect(parsed.limit).toBe(50);
    expect(parsed.properties).toHaveLength(3);
    expect(parsed.properties[0]).toMatchObject({
      propertyId: "uuid-001",
      parcelIdentifier: "1234567890",
      cid: "cid-001",
      county: "Lee",
    });
  });

  it("paginates correctly", async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      buildEntry(`uuid-${i}`, String(1000000000 + i), `cid-${i}`),
    );
    mockFetchOracleManifest.mockResolvedValue(buildManifest(entries));

    const result = await listOraclePropertiesHandler({ limit: 3, offset: 5 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.total).toBe(10);
    expect(parsed.offset).toBe(5);
    expect(parsed.limit).toBe(3);
    expect(parsed.properties).toHaveLength(3);
    expect(parsed.properties[0].propertyId).toBe("uuid-5");
  });

  it("clamps limit to 500", async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      buildEntry(`uuid-${i}`, String(i), `cid-${i}`),
    );
    mockFetchOracleManifest.mockResolvedValue(buildManifest(entries));

    const result = await listOraclePropertiesHandler({ limit: 999 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.limit).toBe(500);
  });

  it("filters by county name (manifest-level equality match)", async () => {
    const entries = [
      buildEntry("uuid-001", "1234567890", "cid-001"),
      buildEntry("uuid-002", "2345678901", "cid-002"),
    ];
    mockFetchOracleManifest.mockResolvedValue(buildManifest(entries));

    const result = await listOraclePropertiesHandler({ county: "Lee" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.total).toBe(2);
    expect(parsed.properties).toHaveLength(2);
  });

  it("county filter is case-insensitive", async () => {
    const entries = [buildEntry("uuid-001", "1234567890", "cid-001")];
    mockFetchOracleManifest.mockResolvedValue(buildManifest(entries));

    const result = await listOraclePropertiesHandler({ county: "lee" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.total).toBe(1);
  });

  it("returns empty list when county does not match", async () => {
    const entries = [buildEntry("uuid-001", "1234567890", "cid-001")];
    mockFetchOracleManifest.mockResolvedValue(buildManifest(entries));

    const result = await listOraclePropertiesHandler({ county: "Miami-Dade" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.total).toBe(0);
    expect(parsed.properties).toHaveLength(0);
  });

  it("returns error when manifest fetch fails", async () => {
    mockFetchOracleManifest.mockRejectedValue(new Error("IPFS timeout"));

    const result = await listOraclePropertiesHandler({});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBeTruthy();
    expect(parsed.details).toContain("IPFS timeout");
  });

  it("includes correct slim fields in each property entry", async () => {
    const entries = [
      buildEntry("uuid-abc", "9876543210", "cid-abc", { fileSizeBytes: 4096 }),
    ];
    mockFetchOracleManifest.mockResolvedValue(buildManifest(entries));

    const result = await listOraclePropertiesHandler({});
    const parsed = JSON.parse(result.content[0].text);
    const prop = parsed.properties[0];

    expect(prop.propertyId).toBe("uuid-abc");
    expect(prop.parcelIdentifier).toBe("9876543210");
    expect(prop.cid).toBe("cid-abc");
    expect(prop.county).toBe("Lee");
    expect(prop.fileSizeBytes).toBe(4096);
    expect(prop.collectedAt).toBeUndefined();
  });
});

describe("getOraclePropertyHandler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("fetches by cid directly without touching manifest", async () => {
    const propertyData = { appraisal: { value: 123000 }, permits: [] };
    mockGetJsonByCid.mockResolvedValue(propertyData);

    const result = await getOraclePropertyHandler({ cid: "cid-xyz" });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockFetchOracleManifest).not.toHaveBeenCalled();
    expect(mockGetJsonByCid).toHaveBeenCalledWith("cid-xyz");
    expect(parsed.appraisal.value).toBe(123000);
  });

  it("resolves parcelIdentifier via manifest then fetches", async () => {
    const entries = [buildEntry("uuid-001", "1234567890", "cid-for-parcel")];
    mockFetchOracleManifest.mockResolvedValue(buildManifest(entries));
    const propertyData = { appraisal: { value: 250000 } };
    mockGetJsonByCid.mockResolvedValue(propertyData);

    const result = await getOraclePropertyHandler({
      parcelIdentifier: "1234567890",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockFetchOracleManifest).toHaveBeenCalledOnce();
    expect(mockGetJsonByCid).toHaveBeenCalledWith("cid-for-parcel");
    expect(parsed.appraisal.value).toBe(250000);
  });

  it("resolves propertyId via manifest then fetches", async () => {
    const entries = [buildEntry("uuid-001", "1234567890", "cid-for-uuid")];
    mockFetchOracleManifest.mockResolvedValue(buildManifest(entries));
    const propertyData = { appraisal: { value: 375000 } };
    mockGetJsonByCid.mockResolvedValue(propertyData);

    const result = await getOraclePropertyHandler({ propertyId: "uuid-001" });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockFetchOracleManifest).toHaveBeenCalledOnce();
    expect(mockGetJsonByCid).toHaveBeenCalledWith("cid-for-uuid");
    expect(parsed.appraisal.value).toBe(375000);
  });

  it("returns error when parcelIdentifier not found in manifest", async () => {
    const entries = [buildEntry("uuid-001", "1234567890", "cid-001")];
    mockFetchOracleManifest.mockResolvedValue(buildManifest(entries));

    const result = await getOraclePropertyHandler({
      parcelIdentifier: "9999999999",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain("9999999999");
    expect(mockGetJsonByCid).not.toHaveBeenCalled();
  });

  it("returns error when propertyId not found in manifest", async () => {
    const entries = [buildEntry("uuid-001", "1234567890", "cid-001")];
    mockFetchOracleManifest.mockResolvedValue(buildManifest(entries));

    const result = await getOraclePropertyHandler({
      propertyId: "uuid-unknown",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain("uuid-unknown");
    expect(mockGetJsonByCid).not.toHaveBeenCalled();
  });

  it("returns error when multiple lookup keys are provided", async () => {
    const result = await getOraclePropertyHandler({
      parcelIdentifier: "1234567890",
      cid: "cid-001",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain("exactly one");
    expect(mockFetchOracleManifest).not.toHaveBeenCalled();
    expect(mockGetJsonByCid).not.toHaveBeenCalled();
  });

  it("returns error when all three lookup keys are provided", async () => {
    const result = await getOraclePropertyHandler({
      parcelIdentifier: "1234567890",
      propertyId: "uuid-001",
      cid: "cid-001",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain("exactly one");
  });

  it("returns error when no lookup key is provided", async () => {
    const result = await getOraclePropertyHandler({});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain("exactly one");
    expect(mockFetchOracleManifest).not.toHaveBeenCalled();
    expect(mockGetJsonByCid).not.toHaveBeenCalled();
  });

  it("returns error when IPFS fetch fails", async () => {
    mockGetJsonByCid.mockRejectedValue(new Error("gateway unreachable"));

    const result = await getOraclePropertyHandler({ cid: "cid-bad" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBeTruthy();
    expect(parsed.details).toContain("gateway unreachable");
  });

  it("treats empty string values as missing", async () => {
    const result = await getOraclePropertyHandler({
      cid: "",
      parcelIdentifier: "",
      propertyId: "",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain("exactly one");
  });
});

describe("getOracleDatasetInfoHandler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns dataset summary from manifest", async () => {
    const entries = [
      buildEntry("uuid-001", "1234567890", "cid-001"),
      buildEntry("uuid-002", "2345678901", "cid-002"),
    ];
    mockFetchOracleManifest.mockResolvedValue(buildManifest(entries));
    mockGetManifestCid.mockReturnValue(
      "QmQ6pdjzm4w7ddEjKDekqukqfdBbvDhgphVXqdTsssqK4d",
    );

    const result = await getOracleDatasetInfoHandler();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.county).toBe("Lee");
    expect(parsed.propertyCount).toBe(2);
    expect(parsed.exportedAt).toBe("2024-06-01T00:00:00Z");
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.manifestCid).toBe(
      "QmQ6pdjzm4w7ddEjKDekqukqfdBbvDhgphVXqdTsssqK4d",
    );
  });

  it("falls back to completedAt when exportedAt is absent", async () => {
    mockFetchOracleManifest.mockResolvedValue({
      county: "Lee",
      propertyCount: 1,
      totalBytes: 512,
      completedAt: "2024-05-01T00:00:00Z",
      entries: [buildEntry("uuid-001", "1234567890", "cid-001")],
    });
    mockGetManifestCid.mockReturnValue("QmSomeCid");

    const result = await getOracleDatasetInfoHandler();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.exportedAt).toBe("2024-05-01T00:00:00Z");
  });

  it("returns null fields gracefully when optional fields absent", async () => {
    mockFetchOracleManifest.mockResolvedValue({
      county: "Lee",
      propertyCount: 0,
      entries: [],
    });
    mockGetManifestCid.mockReturnValue("QmSomeCid");

    const result = await getOracleDatasetInfoHandler();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.exportedAt).toBeNull();
    expect(parsed.schemaVersion).toBeNull();
    expect(parsed.totalBytes).toBeNull();
  });

  it("returns error when manifest fetch fails", async () => {
    mockFetchOracleManifest.mockRejectedValue(
      new Error("manifest CID not found"),
    );

    const result = await getOracleDatasetInfoHandler();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBeTruthy();
    expect(parsed.details).toContain("manifest CID not found");
  });
});
