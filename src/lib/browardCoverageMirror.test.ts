import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { OracleDatasetCoverageSnapshotSchema } from "../types/oracleOpenData.ts";

describe("Broward coverage mirror", () => {
  it("preserves the exact validated partial handoff snapshot", () => {
    const rawSnapshot = readFileSync(
      new URL("../../public/coverage/broward.json", import.meta.url),
      "utf8",
    );
    expect(createHash("sha256").update(rawSnapshot).digest("hex")).toBe(
      "4c1e1fdb99e025d1d976ccadaefd0cc602febdcb1334c1ac002671f00f8ca39f",
    );

    const snapshot = OracleDatasetCoverageSnapshotSchema.parse(
      JSON.parse(rawSnapshot),
    );

    expect(snapshot.county).toBe("broward");
    expect(snapshot.publicationScope).toEqual({
      schemaVersion: "1.0",
      level: "partial",
      denominatorBasis: "county_total",
    });
    expect(
      snapshot.datasets.map(
        ({ source, ingested_count, expected_count, cid, ipns_label }) => ({
          source,
          ingested_count,
          expected_count,
          cid,
          ipns_label,
        }),
      ),
    ).toEqual([
      {
        source: "appraisal",
        ingested_count: 526068,
        expected_count: 534309,
        cid: null,
        ipns_label: null,
      },
      {
        source: "permits",
        ingested_count: 1276328,
        expected_count: null,
        cid: null,
        ipns_label: null,
      },
      {
        source: "sunbiz",
        ingested_count: 12432,
        expected_count: null,
        cid: null,
        ipns_label: null,
      },
      {
        source: "bbb",
        ingested_count: 2823,
        expected_count: null,
        cid: null,
        ipns_label: null,
      },
    ]);
    expect(snapshot).toMatchObject({
      schemaVersion: "oracle-node.broward-donphan-snapshot.v2",
      coverage_status: "supported_partial",
      county_complete: false,
      reconciliation: { allBalanced: true },
      permitJoins: {
        linked: 907987,
        unlinked: 368341,
        foreignLinked: 0,
        linkedProperties: 134675,
        roofing: 127690,
        bbbMatchedProperties: 970,
      },
      enrichmentJoins: {
        sunbizRegistrations: 12432,
        sunbizProperties: 9023,
        bbbProfiles: 2823,
        bbbMatchedProperties: 970,
      },
      routeCoverage: {
        totalCurrentRoutes: 32,
        implementedCurrentRoutes: 24,
        unattendedUnavailableCurrentRoutes: 8,
      },
    });
  });
});
