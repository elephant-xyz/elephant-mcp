import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_DATASET_COVERAGE_MAP,
  parseCoverageMap,
  parseCoverageMapAdditions,
  parseCoverageCidFallbackMap,
  resolveCoverageLocation,
  resolveCoverageRuntimeLocation,
  computeCompletionPercent,
  toDatasetInfoCoverageEntry,
  fetchDatasetCoverage,
  getDatasetCoverageEntries,
  clearDatasetCoverageCache,
} from "./datasetCoverage.ts";
import type { OracleDatasetCoverageRow } from "../types/oracleOpenData.ts";
import { CORPORATE_SCOPE_NOTE } from "./corporateManifest.ts";
import { ROCK_ISLAND_PERMIT_SCOPE_NOTE } from "./rockIslandPermit.ts";

const ROCK_ISLAND_COVERAGE_IPNS =
  "k51qzi5uqu5disduz18ogkvf3f2zgdsizl20o034fu8spgh2khri8uxmeo3khv";

const COVERAGE_ENV_KEYS = [
  "DATASET_COVERAGE_MAP",
  "DATASET_COVERAGE_MAP_ADDITIONS",
  "DATASET_COVERAGE_CID_FALLBACK_MAP_ADDITIONS",
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
  scope_note: null,
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

describe("parseCoverageMapAdditions", () => {
  it("returns {} for unset/blank", () => {
    expect(parseCoverageMapAdditions(undefined)).toEqual({});
    expect(parseCoverageMapAdditions("   ")).toEqual({});
  });

  it("normalizes county keys and accepts absolute HTTP(S) URLs", () => {
    expect(
      parseCoverageMapAdditions(
        '{"Rock Island":" https://ipfs.filebase.io/ipfs/QmCoverage "}',
      ),
    ).toEqual({
      "rock-island": "https://ipfs.filebase.io/ipfs/QmCoverage",
    });
  });

  it("fails closed for malformed, local, or non-HTTP additions", () => {
    expect(() => parseCoverageMapAdditions("{not json")).toThrow(
      "contains invalid JSON",
    );
    expect(() => parseCoverageMapAdditions('{"lee":"/tmp/lee.json"}')).toThrow(
      "absolute HTTP(S) URL",
    );
    expect(() =>
      parseCoverageMapAdditions('{"lee":"file:///tmp/lee.json"}'),
    ).toThrow("must use http: or https:");
  });
});

describe("coverage CID fallbacks", () => {
  const coverageCid = "QmYbKVaD44u51w8Bf1KUcqnTCr4mDWNRANCW9k4VcPZ317";

  beforeEach(clearCoverageEnv);
  afterEach(() => {
    clearCoverageEnv();
    vi.restoreAllMocks();
  });

  it("strictly parses county-scoped immutable coverage CIDs", () => {
    expect(
      parseCoverageCidFallbackMap(
        JSON.stringify({ "Rock Island": coverageCid }),
      ),
    ).toEqual({ "rock-island": coverageCid });
  });

  it("resolves stable IPNS before selecting the reviewed immutable CID", async () => {
    process.env.DATASET_COVERAGE_CID_FALLBACK_MAP_ADDITIONS = JSON.stringify({
      "rock-island": coverageCid,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          "x-ipfs-roots": "QmdmGmaCvFgHYxdBzCam8N9FuP5npoL7VzFEJFminhs2zJ",
        },
      }),
    );

    await expect(
      resolveCoverageRuntimeLocation(
        DEFAULT_DATASET_COVERAGE_MAP["rock-island"],
        "rock-island",
      ),
    ).resolves.toBe(`https://ipfs.filebase.io/ipfs/${coverageCid}`);
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://${ROCK_ISLAND_COVERAGE_IPNS}.ipns.dweb.link/`,
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("rejects a fallback that replaces stable IPNS with a direct URL", async () => {
    process.env.DATASET_COVERAGE_CID_FALLBACK_MAP_ADDITIONS = JSON.stringify({
      "rock-island": coverageCid,
    });

    await expect(
      resolveCoverageRuntimeLocation(
        `https://ipfs.filebase.io/ipfs/${coverageCid}`,
        "rock-island",
      ),
    ).rejects.toThrow("base route");
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

  it("adds Rock Island without changing existing built-in counties", () => {
    expect(DEFAULT_DATASET_COVERAGE_MAP).toEqual({
      lee: "https://k51qzi5uqu5dimw0elyh4agbtqe7v2fzp0jcd7b1bcu8kxs0hml7yu1no0z0vd.ipns.dweb.link/",
      "miami-dade":
        "https://k51qzi5uqu5djj45hvhz6z2dnsdg6pkgucds99t0f78d5gmwu19bfv8o9tygno.ipns.dweb.link/",
      orange:
        "https://k51qzi5uqu5dj8n2f8nowh8kts53rvpr62zfj0mz9izc11rfzv56q7m4161lg7.ipns.dweb.link/",
      "palm-beach":
        "https://k51qzi5uqu5djwga4mcd8nx1gbwy4o9rks3gkoe1u5py5wi9tieea7h44nh4g2.ipns.dweb.link/",
      "rock-island": `https://${ROCK_ISLAND_COVERAGE_IPNS}.ipns.dweb.link/`,
    });

    expect(resolveCoverageLocation("Rock Island")).toEqual({
      served: true,
      location: `https://${ROCK_ISLAND_COVERAGE_IPNS}.ipns.dweb.link/`,
      countyKey: "rock-island",
    });
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

  it("gives strict additions highest precedence without dropping base counties", () => {
    process.env.DATASET_COVERAGE_MAP =
      '{"rock-island":"https://example.com/stale.json","lee":"https://example.com/lee.json"}';
    process.env.DATASET_COVERAGE_MAP_ADDITIONS =
      '{"rock-island":"https://ipfs.filebase.io/ipfs/QmCurrentCoverage"}';

    expect(resolveCoverageLocation("Rock Island")).toEqual({
      served: true,
      location: "https://ipfs.filebase.io/ipfs/QmCurrentCoverage",
      countyKey: "rock-island",
    });
    expect(resolveCoverageLocation("Lee")).toEqual({
      served: true,
      location: "https://example.com/lee.json",
      countyKey: "lee",
    });
  });

  it("keeps stable county IPNS primary when an immutable fallback is configured", () => {
    process.env.DATASET_COVERAGE_MAP_ADDITIONS =
      '{"rock-island":"https://elephant-mcp-two.vercel.app/coverage/rock-island.json"}';
    process.env.DATASET_COVERAGE_CID_FALLBACK_MAP_ADDITIONS = JSON.stringify({
      "rock-island": "QmYbKVaD44u51w8Bf1KUcqnTCr4mDWNRANCW9k4VcPZ317",
    });

    expect(resolveCoverageLocation("Rock Island")).toEqual({
      served: true,
      location: `https://${ROCK_ISLAND_COVERAGE_IPNS}.ipns.dweb.link/`,
      countyKey: "rock-island",
    });
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

  it("parses the published Rock Island snake_case coverage contract", async () => {
    const snapshot = {
      county: "rock-island",
      exportedAt: "2026-08-12T17:22:20.507Z",
      datasets: [
        {
          county: "rock-island",
          source: "appraisal",
          ingested_count: 65806,
          expected_count: 65806,
          first_loaded_at: null,
          last_loaded_at: null,
          cid: null,
          ipns_label: null,
        },
        {
          county: "rock-island",
          source: "permits",
          ingested_count: 0,
          expected_count: null,
          first_loaded_at: null,
          last_loaded_at: null,
          cid: null,
          ipns_label: null,
        },
        {
          county: "rock-island",
          source: "corporate",
          ingested_count: 11741,
          expected_count: null,
          first_loaded_at: "2026-07-28T00:00:00.000Z",
          last_loaded_at: "2026-07-29T00:00:00.000Z",
          cid: "QmXcB1Z4NMtrb96MWnyckE3mS9x7jLXLVCorBDBMcAkxGh",
          ipns_label: "oracle-corporate-registration-rock-island",
        },
        {
          county: "rock-island",
          source: "bbb",
          ingested_count: 0,
          expected_count: null,
          first_loaded_at: null,
          last_loaded_at: null,
          cid: null,
          ipns_label: null,
        },
      ],
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(snapshot), { status: 200 }),
      );

    const entries = await getDatasetCoverageEntries("Rock Island");

    expect(fetchSpy).toHaveBeenCalledWith(
      `https://${ROCK_ISLAND_COVERAGE_IPNS}.ipns.dweb.link/`,
      expect.objectContaining({ redirect: "follow" }),
    );
    expect(entries).toEqual([
      {
        source: "appraisal",
        ingestedCount: 65806,
        expectedCount: 65806,
        completionPercent: 100,
        firstLoadedAt: null,
        lastLoadedAt: null,
        cid: null,
        ipnsLabel: null,
      },
      {
        source: "bbb",
        ingestedCount: 0,
        expectedCount: null,
        completionPercent: null,
        firstLoadedAt: null,
        lastLoadedAt: null,
        cid: null,
        ipnsLabel: null,
      },
      {
        source: "corporate",
        ingestedCount: 11741,
        expectedCount: null,
        completionPercent: null,
        firstLoadedAt: "2026-07-28T00:00:00.000Z",
        lastLoadedAt: "2026-07-29T00:00:00.000Z",
        cid: "QmXcB1Z4NMtrb96MWnyckE3mS9x7jLXLVCorBDBMcAkxGh",
        ipnsLabel: "oracle-corporate-registration-rock-island",
        scopeNote: CORPORATE_SCOPE_NOTE,
      },
      {
        source: "permits",
        ingestedCount: 0,
        expectedCount: null,
        completionPercent: null,
        firstLoadedAt: null,
        lastLoadedAt: null,
        cid: null,
        ipnsLabel: null,
        scopeNote: ROCK_ISLAND_PERMIT_SCOPE_NOTE,
      },
    ]);
  });

  it("serves the combined Rock Island property, permit, corporate, and BBB contract", async () => {
    const combinedCoverage = join(
      process.cwd(),
      "public",
      "coverage",
      "rock-island.json",
    );
    process.env.DATASET_COVERAGE_MAP = JSON.stringify({
      "rock-island": combinedCoverage,
    });

    const entries = await getDatasetCoverageEntries("Rock Island");

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "appraisal",
          ingestedCount: 65806,
          completionPercent: 100,
        }),
        expect.objectContaining({
          source: "bbb",
          ingestedCount: 0,
        }),
        expect.objectContaining({
          source: "corporate",
          ingestedCount: 11741,
          firstLoadedAt: "2026-07-28T00:00:00.000Z",
          lastLoadedAt: "2026-07-29T00:00:00.000Z",
          scopeNote: CORPORATE_SCOPE_NOTE,
        }),
        expect.objectContaining({
          source: "permits",
          ingestedCount: 47385,
          expectedCount: 47385,
          completionPercent: 100,
          firstLoadedAt: "2026-08-14T17:57:33.318Z",
          lastLoadedAt: "2026-08-14T23:15:58.058Z",
          scopeNote: ROCK_ISLAND_PERMIT_SCOPE_NOTE,
        }),
      ]),
    );
  });

  it("keeps the legacy camelCase coverage contract compatible", async () => {
    const file = join(dir, "camel-case.json");
    writeFileSync(
      file,
      JSON.stringify({
        county: "not-built-in",
        exported_at: "2026-08-12T17:22:20.507Z",
        datasets: [
          {
            county: "not-built-in",
            source: "appraisal",
            ingestedCount: 3,
            expectedCount: 4,
            completionPercent: 75,
            firstLoadedAt: null,
            lastLoadedAt: "2026-08-12T17:22:20.507Z",
            cid: null,
            ipnsLabel: "legacy-query-table",
          },
        ],
      }),
    );
    process.env.DATASET_COVERAGE_MAP = JSON.stringify({
      "not-built-in": file,
    });

    expect(await getDatasetCoverageEntries("not-built-in")).toEqual([
      {
        source: "appraisal",
        ingestedCount: 3,
        expectedCount: 4,
        completionPercent: 75,
        firstLoadedAt: null,
        lastLoadedAt: "2026-08-12T17:22:20.507Z",
        cid: null,
        ipnsLabel: "legacy-query-table",
      },
    ]);
  });

  it("rejects invalid counts and inconsistent completion values", async () => {
    const file = join(dir, "invalid-counts.json");
    writeFileSync(
      file,
      JSON.stringify({
        county: "not-built-in",
        datasets: [
          {
            county: "not-built-in",
            source: "appraisal",
            ingested_count: 3,
            expected_count: 4,
            completion_percent: 100,
          },
        ],
      }),
    );
    process.env.DATASET_COVERAGE_MAP = JSON.stringify({
      "not-built-in": file,
    });

    expect(await fetchDatasetCoverage("not-built-in")).toBeNull();

    writeFileSync(
      file,
      JSON.stringify({
        county: "not-built-in",
        datasets: [
          {
            county: "not-built-in",
            source: "appraisal",
            ingested_count: -1,
            expected_count: 4,
          },
        ],
      }),
    );
    expect(await fetchDatasetCoverage("not-built-in")).toBeNull();
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
