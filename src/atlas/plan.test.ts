import { describe, expect, it } from "vitest";

import { AtlasIndexV1Schema } from "./contracts.ts";
import { planAtlasSync, type AtlasStateRow } from "./plan.ts";

const ARCHIVE = "baguqeerakenv6uzkrga4lx6jntgqe4ftdrqjgqiigm4h5gedrqopujfa6sda";
const TABLES = "baguqeerasxkelzdxtkgdrii54zoanz3t7qznf72niikqmiyer4dlb2k2xfhq";
const SCHEMA = "bafkreia6tjziby3upxmidymud5iusd32urrztslgrudkwysc7ydmxoekuq";
const INDEX = "bafkreici4fnvhn42zqyxb4ltlrocldghfagnbxhzgjkbck546t6cm6mtky";

function index() {
  return AtlasIndexV1Schema.parse({
    version: 1,
    generated_from: "b43e8d4adb33d43798e610efe404afc79db14642",
    counties: [
      {
        county: "lee",
        state: "FL",
        fips: "12071",
        groups: {
          county: {
            cid: ARCHIVE,
            schema: SCHEMA,
            tables: TABLES,
            published_at: "2026-09-21T17:23:52.000Z",
          },
        },
      },
    ],
  });
}

function state(overrides: Partial<AtlasStateRow> = {}): AtlasStateRow {
  return {
    county: "lee",
    state: "FL",
    fips: "12071",
    dataGroup: "county",
    archiveCid: ARCHIVE,
    tablesCid: TABLES,
    schemaCid: SCHEMA,
    publishedAt: "2026-09-21T17:23:52.000Z",
    ...overrides,
  };
}

describe("Atlas sync planning", () => {
  it("does no group work when the index CID is unchanged", () => {
    expect(
      planAtlasSync(
        index(),
        INDEX,
        { indexCid: INDEX, generatedFrom: "previous" },
        [state()],
      ),
    ).toMatchObject({
      unchanged: true,
      groups: [],
      withdrawals: [],
    });
  });

  it("skips an unchanged tables publication", () => {
    const plan = planAtlasSync(index(), INDEX, null, [state()]);

    expect(plan.groups).toEqual([
      expect.objectContaining({
        action: "skip",
        county: "lee",
        dataGroup: "county",
      }),
    ]);
    expect(plan.withdrawals).toEqual([]);
  });

  it("loads a changed group and withdraws a missing group", () => {
    const plan = planAtlasSync(index(), INDEX, null, [
      state({ tablesCid: ARCHIVE }),
      state({ county: "orange", dataGroup: "county" }),
    ]);

    expect(plan.groups[0]).toMatchObject({
      action: "load",
      county: "lee",
      dataGroup: "county",
    });
    expect(plan.withdrawals).toEqual([
      {
        action: "withdraw",
        county: "orange",
        dataGroup: "county",
        state: "FL",
      },
    ]);
  });

  it("withdraws all groups for an empty index", () => {
    const empty = AtlasIndexV1Schema.parse({
      version: 1,
      generated_from: "b43e8d4adb33d43798e610efe404afc79db14642",
      counties: [],
    });

    expect(planAtlasSync(empty, INDEX, null, [state()]).withdrawals).toEqual([
      { action: "withdraw", county: "lee", dataGroup: "county", state: "FL" },
    ]);
  });
});
