import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listOraclePropertiesHandler,
  getOraclePropertyHandler,
  getOracleDatasetInfoHandler,
} from "./oracleOpenData.ts";

vi.mock("../lib/ipfs.ts", () => ({
  getJsonByCid: vi.fn(),
  fetchShardByCid: vi.fn(),
}));

vi.mock("../lib/oracleManifest.ts", () => ({
  fetchOracleManifest: vi.fn(),
  getManifestCid: vi.fn(),
  fetchOracleIndex: vi.fn(),
  getIndexCid: vi.fn(),
}));

const { getJsonByCid, fetchShardByCid } = await import("../lib/ipfs.ts");
const { fetchOracleManifest, getManifestCid, fetchOracleIndex, getIndexCid } =
  await import("../lib/oracleManifest.ts");

const mockGetJsonByCid = vi.mocked(getJsonByCid);
const mockFetchShardByCid = vi.mocked(fetchShardByCid);
const mockFetchOracleManifest = vi.mocked(fetchOracleManifest);
const mockGetManifestCid = vi.mocked(getManifestCid);
const mockFetchOracleIndex = vi.mocked(fetchOracleIndex);
const mockGetIndexCid = vi.mocked(getIndexCid);

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

/** Build a minimal ShardRef */
const buildShardRef = (
  shardIndex: number,
  fromParcel: string,
  toParcel: string,
  count: number,
  shardCid: string | null = `shard-cid-${shardIndex}`,
) => ({ shardIndex, fromParcel, toParcel, count, shardCid });

/** Build a minimal OracleIndex */
const buildIndex = (
  shards: ReturnType<typeof buildShardRef>[],
  county = "Lee",
) => ({
  schemaVersion: "1" as const,
  county,
  exportedAt: "2024-06-01T00:00:00Z",
  completedAt: "2024-06-01T01:00:00Z",
  propertyCount: shards.reduce((s, sh) => s + sh.count, 0),
  shardSize: 2,
  totalBytes: 10240,
  shards,
});

/** Build a shard file with entries */
const buildShardFile = (
  shardIndex: number,
  entries: Array<{ propertyId: string; parcelIdentifier: string; cid: string }>,
) => ({
  schemaVersion: "1" as const,
  shardIndex,
  fromParcel: entries[0].parcelIdentifier,
  toParcel: entries[entries.length - 1].parcelIdentifier,
  count: entries.length,
  entries: entries.map((e) => ({ ...e, fileSizeBytes: 1024 })),
});

describe("listOraclePropertiesHandler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no index available → fall back to manifest
    mockFetchOracleIndex.mockResolvedValue(null);
    mockGetIndexCid.mockReturnValue(null);
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

  // === Sharded index path tests ===

  it("[shard path] pages across shards with correct slice offsets", async () => {
    // 3 shards of 2 entries each = 6 total
    const shards = [
      buildShardRef(0, "1000", "1001", 2, "shard-cid-0"),
      buildShardRef(1, "2000", "2001", 2, "shard-cid-1"),
      buildShardRef(2, "3000", "3001", 2, "shard-cid-2"),
    ];
    mockFetchOracleIndex.mockResolvedValue(buildIndex(shards));

    const shard1 = buildShardFile(1, [
      { propertyId: "p-2", parcelIdentifier: "2000", cid: "cid-2000" },
      { propertyId: "p-3", parcelIdentifier: "2001", cid: "cid-2001" },
    ]);

    // offset=2, limit=2 → should only need shard 1 (shards 0 and 2 must NOT be fetched)
    mockFetchShardByCid.mockResolvedValueOnce(shard1);

    const result = await listOraclePropertiesHandler({ offset: 2, limit: 2 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.total).toBe(6);
    expect(parsed.offset).toBe(2);
    expect(parsed.limit).toBe(2);
    expect(parsed.properties).toHaveLength(2);
    expect(parsed.properties[0].parcelIdentifier).toBe("2000");
    expect(parsed.properties[1].parcelIdentifier).toBe("2001");
    // Shard 0 and 2 should NOT be fetched
    expect(mockFetchShardByCid).toHaveBeenCalledTimes(1);
    expect(mockFetchShardByCid).toHaveBeenCalledWith("shard-cid-1");
    // fetchOracleManifest should not be called when index is available
    expect(mockFetchOracleManifest).not.toHaveBeenCalled();
  });

  it("[shard path] returns empty list when county doesn't match index county", async () => {
    const shards = [buildShardRef(0, "1000", "1001", 2)];
    mockFetchOracleIndex.mockResolvedValue(buildIndex(shards, "Lee"));

    const result = await listOraclePropertiesHandler({ county: "Miami-Dade" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.total).toBe(0);
    expect(parsed.properties).toHaveLength(0);
    expect(mockFetchShardByCid).not.toHaveBeenCalled();
  });

  it("[shard path] handles page spanning two shards", async () => {
    const shards = [
      buildShardRef(0, "1000", "1001", 2, "shard-cid-0"),
      buildShardRef(1, "2000", "2001", 2, "shard-cid-1"),
    ];
    mockFetchOracleIndex.mockResolvedValue(buildIndex(shards));

    const shard0 = buildShardFile(0, [
      { propertyId: "p-0", parcelIdentifier: "1000", cid: "cid-1000" },
      { propertyId: "p-1", parcelIdentifier: "1001", cid: "cid-1001" },
    ]);
    const shard1 = buildShardFile(1, [
      { propertyId: "p-2", parcelIdentifier: "2000", cid: "cid-2000" },
      { propertyId: "p-3", parcelIdentifier: "2001", cid: "cid-2001" },
    ]);

    // offset=1, limit=2 → needs last entry of shard0 + first entry of shard1
    mockFetchShardByCid
      .mockResolvedValueOnce(shard0)
      .mockResolvedValueOnce(shard1);

    const result = await listOraclePropertiesHandler({ offset: 1, limit: 2 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.properties).toHaveLength(2);
    expect(parsed.properties[0].parcelIdentifier).toBe("1001");
    expect(parsed.properties[1].parcelIdentifier).toBe("2000");
    expect(mockFetchShardByCid).toHaveBeenCalledTimes(2);
  });
});

describe("getOraclePropertyHandler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFetchOracleIndex.mockResolvedValue(null);
    mockGetIndexCid.mockReturnValue(null);
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

  // === Sharded index path tests ===

  it("[shard path] resolves parcelIdentifier via binary search on index", async () => {
    const shards = [
      buildShardRef(0, "1000", "1999", 2, "shard-cid-0"),
      buildShardRef(1, "2000", "2999", 2, "shard-cid-1"),
    ];
    mockFetchOracleIndex.mockResolvedValue(buildIndex(shards));

    const shard1 = buildShardFile(1, [
      { propertyId: "p-2", parcelIdentifier: "2000", cid: "cid-prop-2000" },
      { propertyId: "p-3", parcelIdentifier: "2500", cid: "cid-prop-2500" },
    ]);
    mockFetchShardByCid.mockResolvedValueOnce(shard1);

    const propertyData = { appraisal: { value: 99000 } };
    mockGetJsonByCid.mockResolvedValue(propertyData);

    const result = await getOraclePropertyHandler({
      parcelIdentifier: "2000",
    });
    const parsed = JSON.parse(result.content[0].text);

    // Should only fetch shard 1 (binary search), not shard 0
    expect(mockFetchShardByCid).toHaveBeenCalledTimes(1);
    expect(mockFetchShardByCid).toHaveBeenCalledWith("shard-cid-1");
    expect(mockGetJsonByCid).toHaveBeenCalledWith("cid-prop-2000");
    expect(parsed.appraisal.value).toBe(99000);
    // Manifest should not be touched
    expect(mockFetchOracleManifest).not.toHaveBeenCalled();
  });

  it("[shard path] returns not-found error when parcel not in any shard range", async () => {
    const shards = [buildShardRef(0, "1000", "1999", 2, "shard-cid-0")];
    mockFetchOracleIndex.mockResolvedValue(buildIndex(shards));

    const result = await getOraclePropertyHandler({
      parcelIdentifier: "9999",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain("9999");
    expect(mockFetchShardByCid).not.toHaveBeenCalled();
    expect(mockGetJsonByCid).not.toHaveBeenCalled();
  });

  it("[shard path] resolves propertyId via linear scan across shards", async () => {
    const shards = [
      buildShardRef(0, "1000", "1999", 2, "shard-cid-0"),
      buildShardRef(1, "2000", "2999", 2, "shard-cid-1"),
    ];
    mockFetchOracleIndex.mockResolvedValue(buildIndex(shards));

    const shard0 = buildShardFile(0, [
      { propertyId: "p-0", parcelIdentifier: "1000", cid: "cid-1000" },
      { propertyId: "p-1", parcelIdentifier: "1500", cid: "cid-1500" },
    ]);
    const shard1 = buildShardFile(1, [
      { propertyId: "p-2", parcelIdentifier: "2000", cid: "cid-2000" },
      { propertyId: "p-3", parcelIdentifier: "2500", cid: "cid-2500" },
    ]);
    // First shard doesn't contain p-2, second one does
    mockFetchShardByCid
      .mockResolvedValueOnce(shard0)
      .mockResolvedValueOnce(shard1);

    const propertyData = { appraisal: { value: 55000 } };
    mockGetJsonByCid.mockResolvedValue(propertyData);

    const result = await getOraclePropertyHandler({ propertyId: "p-2" });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockGetJsonByCid).toHaveBeenCalledWith("cid-2000");
    expect(parsed.appraisal.value).toBe(55000);
  });
});

describe("getOracleDatasetInfoHandler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFetchOracleIndex.mockResolvedValue(null);
    mockGetIndexCid.mockReturnValue(null);
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
    expect(parsed.indexCid).toBeNull();
    expect(parsed.ipnsName).toBeNull();
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

  // === Sharded index path tests ===

  it("[shard path] returns index-based dataset info when index is available", async () => {
    const shards = [
      buildShardRef(0, "1000", "1999", 100, "shard-cid-0"),
      buildShardRef(1, "2000", "2999", 100, "shard-cid-1"),
    ];
    mockFetchOracleIndex.mockResolvedValue(buildIndex(shards));
    mockGetIndexCid.mockReturnValue("QmIndexCidXyz");

    const result = await getOracleDatasetInfoHandler();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.county).toBe("Lee");
    expect(parsed.propertyCount).toBe(200);
    expect(parsed.exportedAt).toBe("2024-06-01T00:00:00Z");
    expect(parsed.completedAt).toBe("2024-06-01T01:00:00Z");
    expect(parsed.shardSize).toBe(2);
    expect(parsed.shardCount).toBe(2);
    expect(parsed.indexCid).toBe("QmIndexCidXyz");
    expect(parsed.ipnsName).toBeNull();
    // Manifest should NOT be consulted
    expect(mockFetchOracleManifest).not.toHaveBeenCalled();
  });
});
