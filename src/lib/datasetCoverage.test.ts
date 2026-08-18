import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_DATASET_COVERAGE_MAP,
  parseCoverageMap,
  resolveCoverageLocation,
  computeCompletionPercent,
  toDatasetInfoCoverageEntry,
  fetchDatasetCoverage,
  getDatasetCoverageEntries,
  clearDatasetCoverageCache,
} from "./datasetCoverage.ts";
import type { OracleDatasetCoverageRow } from "../types/oracleOpenData.ts";

const COVERAGE_ENV_KEYS = [
  "DATASET_COVERAGE_MAP",
  "DATASET_COVERAGE",
  "DATASET_COVERAGE_DEFAULT_COUNTY",
] as const;

function clearCoverageEnv(): void {
  for (const key of COVERAGE_ENV_KEYS) {
    delete process.env[key];
  }
}

const sampleRow = (
  overrides: Partial<OracleDatasetCoverageRow> = {},
): OracleDatasetCoverageRow => ({
  county: "lee",
  source: "appraisal",
  ingested_count: 50,
  expected_count: 100,
  first_loaded_at: "2026-07-01T00:00:00Z",
  last_loaded_at: "2026-07-08T00:00:00Z",
  cid: "QmCid",
  ipns_label: "oracle-query-table-lee",
  ...overrides,
});

describe("parseCoverageMap", () => {
  it("returns {} for unset/blank", () => {
    expect(parseCoverageMap(undefined)).toEqual({});
    expect(parseCoverageMap("   ")).toEqual({});
  });

  it("returns {} for malformed JSON", () => {
    expect(parseCoverageMap("{not json")).toEqual({});
  });

  it("returns {} for non-object JSON", () => {
    expect(parseCoverageMap("[1,2,3]")).toEqual({});
  });

  it("normalizes county keys and trims values", () => {
    const map = parseCoverageMap(
      '{"Miami-Dade":"  https://x/cov.json  ","lee":"/tmp/lee.json"}',
    );
    expect(map["miami-dade"]).toBe("https://x/cov.json");
    expect(map["lee"]).toBe("/tmp/lee.json");
  });

  it("skips blank/non-string entries", () => {
    const map = parseCoverageMap('{"lee":"","pb":42,"orange":"/o.json"}');
    expect(map["lee"]).toBeUndefined();
    expect(map["pb"]).toBeUndefined();
    expect(map["orange"]).toBe("/o.json");
  });
});

describe("resolveCoverageLocation", () => {
  beforeEach(clearCoverageEnv);
  afterEach(clearCoverageEnv);

  it("uses the single location in legacy mode", () => {
    process.env.DATASET_COVERAGE = "/tmp/single.json";
    const res = resolveCoverageLocation("not-built-in");
    expect(res.served).toBe(true);
    expect(res.location).toBe("/tmp/single.json");
  });

  it("uses the built-in coverage map for published counties", () => {
    const res = resolveCoverageLocation("Lee");
    expect(res.served).toBe(true);
    expect(res.location).toBe(DEFAULT_DATASET_COVERAGE_MAP.lee);
    expect(res.countyKey).toBe("lee");
  });

  it("not served when an unknown county has no configured snapshot", () => {
    const res = resolveCoverageLocation("not-built-in");
    expect(res.served).toBe(false);
    expect(res.location).toBeNull();
  });

  it("lets DATASET_COVERAGE_MAP override a built-in county", () => {
    process.env.DATASET_COVERAGE_MAP = '{"lee":"/tmp/lee.json"}';
    const res = resolveCoverageLocation("Lee");
    expect(res.served).toBe(true);
    expect(res.location).toBe("/tmp/lee.json");
    expect(res.countyKey).toBe("lee");
  });

  it("resolves a mapped county outside the built-in defaults", () => {
    process.env.DATASET_COVERAGE_MAP = '{"santa-clara":"/tmp/sc.json"}';
    const res = resolveCoverageLocation("Santa Clara");
    expect(res.served).toBe(true);
    expect(res.location).toBe("/tmp/sc.json");
    expect(res.countyKey).toBe("santa-clara");
  });

  it("falls back to single location for the default county", () => {
    process.env.DATASET_COVERAGE_MAP = '{"lee":"/tmp/lee.json"}';
    process.env.DATASET_COVERAGE = "/tmp/single.json";
    process.env.DATASET_COVERAGE_DEFAULT_COUNTY = "not-built-in";
    const res = resolveCoverageLocation("not-built-in");
    expect(res.served).toBe(true);
    expect(res.location).toBe("/tmp/single.json");
  });
});

describe("computeCompletionPercent", () => {
  it("rounds ingested/expected * 100", () => {
    expect(computeCompletionPercent(50, 100)).toBe(50);
    expect(computeCompletionPercent(1, 3)).toBe(33);
    expect(computeCompletionPercent(2, 3)).toBe(67);
  });

  it("null when expected is missing or non-positive", () => {
    expect(computeCompletionPercent(50, null)).toBeNull();
    expect(computeCompletionPercent(50, undefined)).toBeNull();
    expect(computeCompletionPercent(50, 0)).toBeNull();
  });
});

describe("toDatasetInfoCoverageEntry", () => {
  it("maps snake_case row to camelCase entry with percent", () => {
    const entry = toDatasetInfoCoverageEntry(sampleRow());
    expect(entry).toEqual({
      source: "appraisal",
      ingestedCount: 50,
      expectedCount: 100,
      completionPercent: 50,
      firstLoadedAt: "2026-07-01T00:00:00Z",
      lastLoadedAt: "2026-07-08T00:00:00Z",
      cid: "QmCid",
      ipnsLabel: "oracle-query-table-lee",
    });
  });

  it("nulls optional fields and percent when expected absent", () => {
    const entry = toDatasetInfoCoverageEntry(
      sampleRow({
        expected_count: null,
        first_loaded_at: null,
        last_loaded_at: null,
        cid: null,
        ipns_label: null,
      }),
    );
    expect(entry.expectedCount).toBeNull();
    expect(entry.completionPercent).toBeNull();
    expect(entry.cid).toBeNull();
  });
});

describe("fetchDatasetCoverage / getDatasetCoverageEntries", () => {
  let dir: string;

  beforeEach(() => {
    clearCoverageEnv();
    clearDatasetCoverageCache();
    dir = mkdtempSync(join(tmpdir(), "coverage-"));
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearCoverageEnv();
    clearDatasetCoverageCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads and validates a local snapshot file", async () => {
    const file = join(dir, "lee.json");
    writeFileSync(
      file,
      JSON.stringify({
        county: "lee",
        exportedAt: "2026-07-08T00:00:00Z",
        datasets: [
          sampleRow(),
          sampleRow({
            source: "permits",
            ingested_count: 27,
            expected_count: null,
          }),
        ],
      }),
    );
    process.env.DATASET_COVERAGE_MAP = JSON.stringify({ lee: file });

    const entries = await getDatasetCoverageEntries("lee");
    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(2);
    // sorted by source: appraisal before permits
    expect(entries?.[0]?.source).toBe("appraisal");
    expect(entries?.[0]?.completionPercent).toBe(50);
    expect(entries?.[1]?.source).toBe("permits");
    expect(entries?.[1]?.completionPercent).toBeNull();
  });

  it("returns null when the county has no configured snapshot", async () => {
    expect(await getDatasetCoverageEntries("not-built-in")).toBeNull();
  });

  it("returns null (not throw) for a malformed snapshot", async () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ county: "lee", datasets: "nope" }));
    process.env.DATASET_COVERAGE_MAP = JSON.stringify({ lee: file });
    expect(await fetchDatasetCoverage("lee")).toBeNull();
  });

  it("returns null (not throw) when the file is missing", async () => {
    process.env.DATASET_COVERAGE_MAP = JSON.stringify({
      lee: join(dir, "does-not-exist.json"),
    });
    expect(await fetchDatasetCoverage("lee")).toBeNull();
  });

  it("fetches an http location via global fetch", async () => {
    const snapshot = {
      county: "lee",
      exportedAt: "2026-07-08T00:00:00Z",
      datasets: [sampleRow()],
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(snapshot), { status: 200 }),
      );
    process.env.DATASET_COVERAGE_MAP = JSON.stringify({
      lee: "https://gw/ipns/x/dataset-coverage.json",
    });

    const result = await fetchDatasetCoverage("lee");
    expect(result?.datasets).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://gw/ipns/x/dataset-coverage.json",
      expect.objectContaining({
        redirect: "follow",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("caches the snapshot within the TTL (one read per county)", async () => {
    const snapshot = { county: "lee", datasets: [sampleRow()] };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(snapshot), { status: 200 }),
      );
    process.env.DATASET_COVERAGE_MAP = JSON.stringify({
      lee: "https://gw/c.json",
    });

    await fetchDatasetCoverage("lee");
    await fetchDatasetCoverage("lee");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores a snapshot whose county does not match the requested county", async () => {
    const file = join(dir, "stale.json");
    writeFileSync(
      file,
      JSON.stringify({
        county: "orange",
        exportedAt: "2026-07-08T00:00:00Z",
        datasets: [sampleRow({ county: "orange" })],
      }),
    );
    process.env.DATASET_COVERAGE_MAP = JSON.stringify({ lee: file });

    expect(await fetchDatasetCoverage("lee")).toBeNull();
  });

  it("does not cache a failed read, so a later successful read still resolves", async () => {
    const snapshot = {
      county: "lee",
      exportedAt: "2026-07-08T00:00:00Z",
      datasets: [sampleRow()],
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(snapshot), { status: 200 }),
      );
    process.env.DATASET_COVERAGE_MAP = JSON.stringify({
      lee: "https://gw/c.json",
    });

    expect(await fetchDatasetCoverage("lee")).toBeNull();
    const second = await fetchDatasetCoverage("lee");
    expect(second?.datasets).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
