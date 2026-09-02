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
        cid: "QmWMVYR3JSoNg1TAgTyCEK2fxFgqu5ux4BcE9SKdj3AaPk",
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
        cid: "QmYPRStJYA9Pstm3BaMDq73wJYMNXxWcPHL4FEEbUT6KjN",
        ipns_label: "oracle-permit-table-broward",
      },
    ]);
  });
});
