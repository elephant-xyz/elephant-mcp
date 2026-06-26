/**
 * Story 3 — AC1: geo index config/env behaviour.
 *
 * INTENTIONALLY RED until `./oracleGeoIndex.ts` exists.
 *
 * Scope fence: the derived geo index must be resolved through its OWN env vars
 * (ORACLE_GEO_INDEX_CID / ORACLE_GEO_INDEX_IPNS) — it must NOT pigg-back on or
 * mutate the open-data manifest vars (ORACLE_OPEN_DATA_IPNS /
 * ORACLE_OPEN_DATA_INDEX_CID). This keeps the two datasets independent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ENV_KEYS = [
  "ORACLE_GEO_INDEX_CID",
  "ORACLE_GEO_INDEX_IPNS",
  "ORACLE_OPEN_DATA_IPNS",
  "ORACLE_OPEN_DATA_INDEX_CID",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("getGeoIndexCid — separate env var (red)", () => {
  it("returns the ORACLE_GEO_INDEX_CID value when set", async () => {
    process.env.ORACLE_GEO_INDEX_CID = "QmGeoCid123";
    const { getGeoIndexCid } = await import("./oracleGeoIndex.ts");
    expect(getGeoIndexCid()).toBe("QmGeoCid123");
  });

  it("returns null when no geo CID env var is set", async () => {
    const { getGeoIndexCid } = await import("./oracleGeoIndex.ts");
    expect(getGeoIndexCid()).toBeNull();
  });

  it("does NOT fall back to the open-data manifest CID env var", async () => {
    // Only the open-data var is set; the geo loader must stay null because it
    // is a distinct dataset with its own var.
    process.env.ORACLE_OPEN_DATA_INDEX_CID = "QmOpenDataIndexCid";
    const { getGeoIndexCid } = await import("./oracleGeoIndex.ts");
    expect(getGeoIndexCid()).toBeNull();
  });

  it("reading the geo CID does not mutate ORACLE_OPEN_DATA_IPNS", async () => {
    process.env.ORACLE_OPEN_DATA_IPNS = "k51-open-data-ipns";
    process.env.ORACLE_GEO_INDEX_CID = "QmGeoCid123";
    const { getGeoIndexCid } = await import("./oracleGeoIndex.ts");

    getGeoIndexCid();

    expect(process.env.ORACLE_OPEN_DATA_IPNS).toBe("k51-open-data-ipns");
  });
});
