import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { OracleDatasetCoverageSnapshotSchema } from "../types/oracleOpenData.ts";

describe("Broward coverage mirror", () => {
  it("preserves the validated partial multi-source snapshot", () => {
    const snapshot = OracleDatasetCoverageSnapshotSchema.parse(
      JSON.parse(
        readFileSync(
          new URL("../../public/coverage/broward.json", import.meta.url),
          "utf8",
        ),
      ),
    );

    expect(snapshot.county).toBe("broward");
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
        expected_count: null,
        cid: "QmPUFdWJuXsFut6XZTQSEuBNCyfz22uu3AuorrVSXdsHnU",
        ipns_label: "oracle-query-table-broward",
      },
      {
        source: "bbb",
        ingested_count: 2102,
        expected_count: null,
        cid: null,
        ipns_label: null,
      },
      {
        source: "permits",
        ingested_count: 495465,
        expected_count: null,
        cid: "Qmb1XuBnD7c3xs99bUuHUWfhEoVNwuo4eNfWQHFa6Fdbis",
        ipns_label: "oracle-permit-table-broward",
      },
    ]);
  });
});
