import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { OracleDatasetCoverageSnapshotSchema } from "../types/oracleOpenData.ts";

const COVERAGE_PATH = new URL(
  "../../public/coverage/rock-island.json",
  import.meta.url,
);

describe("Rock Island public coverage mirror", () => {
  it("matches the existing coverage contract and reviewed publication counts", () => {
    const snapshot = OracleDatasetCoverageSnapshotSchema.parse(
      JSON.parse(readFileSync(COVERAGE_PATH, "utf8")),
    );
    const bySource = new Map(
      snapshot.datasets.map((dataset) => [dataset.source, dataset]),
    );

    expect(snapshot.county).toBe("rock-island");
    expect(snapshot.exportedAt).toBe("2026-08-14T23:27:16.472Z");
    expect([...bySource.keys()]).toEqual([
      "appraisal",
      "permits",
      "corporate",
      "bbb",
      "overture_places",
    ]);

    expect(bySource.get("appraisal")).toMatchObject({
      county: "rock-island",
      ingested_count: 65_806,
      expected_count: 65_806,
      cid: "QmWo6htg7j51ue7BhubgRytVDTgEkAAUffJFZB7GkM9iP4",
    });
    expect(bySource.get("permits")).toMatchObject({
      county: "rock-island",
      ingested_count: 47_385,
      expected_count: 47_385,
      cid: "QmYfhGF427Yvbv8B2e8rvP2idTQp5yEyKCgbj4bzRHGEaW",
    });
    expect(bySource.get("corporate")).toMatchObject({
      county: "rock-island",
      ingested_count: 11_741,
      expected_count: null,
      cid: "QmXcB1Z4NMtrb96MWnyckE3mS9x7jLXLVCorBDBMcAkxGh",
    });
    expect(bySource.get("bbb")).toMatchObject({
      county: "rock-island",
      ingested_count: 0,
      expected_count: null,
      cid: null,
    });
    expect(bySource.get("overture_places")).toMatchObject({
      county: "rock-island",
      ingested_count: 0,
      expected_count: null,
      cid: null,
    });

    expect(bySource.get("permits")?.scope_note).toContain(
      "24,786 City of Rock Island records",
    );
    expect(bySource.get("permits")?.scope_note).toContain(
      "22,599 Moline records",
    );
    expect(bySource.get("permits")?.scope_note).toContain(
      "Sixty-one ambiguous",
    );
  });
});
