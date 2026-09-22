import { describe, expect, it } from "vitest";

import { getAtlasProperty } from "./query.ts";
import { resetAtlasRuntimeForTests } from "./runtime.ts";
import { syncAtlas } from "./sync.ts";

const enabled = process.env.ATLAS_LIVE_TEST === "1";

describe.runIf(enabled)("live Atlas synchronization", () => {
  it("resolves Atlas, synchronizes SQL, and optionally verifies a known property", async () => {
    const summary = await syncAtlas();
    expect(summary.indexCid).toMatch(/^b[a-z2-7]+$/u);

    const state = process.env.ATLAS_LIVE_STATE;
    const county = process.env.ATLAS_LIVE_COUNTY;
    const dataGroup = process.env.ATLAS_LIVE_DATA_GROUP;
    const propertyCid = process.env.ATLAS_LIVE_PROPERTY_CID;
    if (
      state !== undefined &&
      county !== undefined &&
      dataGroup !== undefined &&
      propertyCid !== undefined
    ) {
      resetAtlasRuntimeForTests();
      await expect(
        getAtlasProperty({ county, dataGroup, propertyCid, state }),
      ).resolves.toMatchObject({
        propertyCid,
        source: { county, dataGroup, indexCid: summary.indexCid, state },
      });
    }
  }, 120_000);
});
