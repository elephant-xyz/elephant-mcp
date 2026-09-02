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
      "78c41900e2e781c47296b010686539c0b31112f6b72359b702c0fc943a85cae2",
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
        ingested_count: 496064,
        expected_count: null,
        cid: null,
        ipns_label: null,
      },
      {
        source: "corporate",
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
        linked: 360392,
        unlinked: 135672,
        foreignLinked: 0,
        linkedProperties: 67499,
        roofing: 48899,
      },
      routeCoverage: {
        totalCurrentRoutes: 32,
        implementedCurrentRoutes: 24,
        unattendedUnavailableCurrentRoutes: 8,
      },
    });
  });
});
