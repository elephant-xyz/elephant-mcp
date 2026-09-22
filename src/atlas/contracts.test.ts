import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it } from "vitest";

import {
  AtlasIndexV1Schema,
  CountyIndexV1Schema,
  CountyTablesV1Schema,
  parseCountyTablesV1,
} from "./contracts.ts";

async function cid(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return CID.createV1(raw.code, await sha256.digest(bytes)).toString();
}

async function atlasIndex() {
  return {
    version: 1,
    generated_from: "a".repeat(40),
    counties: [
      {
        county: "miami-dade",
        state: "FL",
        fips: "12086",
        groups: {
          property_improvement: {
            cid: await cid("archive"),
            schema: await cid("schema"),
            tables: await cid("tables"),
            published_at: "2026-09-21T17:23:52.000Z",
          },
        },
      },
    ],
  };
}

async function countyTables() {
  return {
    label: "CountyTables",
    version: 1,
    county_root: await cid("archive"),
    part_size_bytes: 1_073_741_824,
    codec: "zstd",
    tables: {
      properties: {
        rows: 0,
        parts: [],
      },
      property_improvement: {
        rows: 3,
        parts: [
          { cid: await cid("part-a"), rows: 1, bytes: 128 },
          { cid: await cid("part-b"), rows: 2, bytes: 256 },
        ],
      },
    },
  };
}

describe("Atlas v1 contracts", () => {
  it("accepts a strict Atlas index and rejects unknown fields", async () => {
    const input = await atlasIndex();

    expect(AtlasIndexV1Schema.parse(input)).toEqual(input);
    expect(
      AtlasIndexV1Schema.safeParse({ ...input, unexpected: true }).success,
    ).toBe(false);
  });

  it("validates index versions, identifiers, CIDs, and county uniqueness", async () => {
    const input = await atlasIndex();
    const group = input.counties[0].groups.property_improvement;

    expect(AtlasIndexV1Schema.safeParse({ ...input, version: 2 }).success).toBe(
      false,
    );
    expect(
      AtlasIndexV1Schema.safeParse({
        ...input,
        counties: [{ ...input.counties[0], county: "Miami Dade" }],
      }).success,
    ).toBe(false);
    expect(
      AtlasIndexV1Schema.safeParse({
        ...input,
        counties: [
          {
            ...input.counties[0],
            groups: { "property-improvement": group },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AtlasIndexV1Schema.safeParse({
        ...input,
        counties: [
          {
            ...input.counties[0],
            groups: {
              property_improvement: { ...group, cid: "not-a-cid" },
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AtlasIndexV1Schema.safeParse({
        ...input,
        counties: [...input.counties, input.counties[0]],
      }).success,
    ).toBe(false);
    expect(
      AtlasIndexV1Schema.safeParse({
        ...input,
        counties: [
          ...input.counties,
          {
            ...input.counties[0],
            county: "orange",
            fips: "12095",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("validates and normalizes decoded CountyIndex CID links", async () => {
    const shard = CID.parse(await cid("shard"));
    const parsed = CountyIndexV1Schema.parse({
      label: "CountyIndex",
      version: 1,
      properties: 4,
      shards: [shard],
    });

    expect(parsed.shards).toEqual([shard.toString()]);
    expect(
      CountyIndexV1Schema.safeParse({
        label: "CountyIndex",
        version: 2,
        properties: 4,
        shards: [shard],
      }).success,
    ).toBe(false);
    expect(
      CountyIndexV1Schema.safeParse({
        label: "CountyIndex",
        version: 1,
        properties: -1,
        shards: [shard],
      }).success,
    ).toBe(false);
  });

  it("accepts valid CountyTables and binds it to the CountyIndex root", async () => {
    const input = await countyTables();
    const decoded = {
      ...input,
      county_root: CID.parse(input.county_root),
      tables: {
        ...input.tables,
        property_improvement: {
          ...input.tables.property_improvement,
          parts: input.tables.property_improvement.parts.map((part) => ({
            ...part,
            cid: CID.parse(part.cid),
          })),
        },
      },
    };

    expect(parseCountyTablesV1(decoded, input.county_root)).toEqual(input);
    const otherRoot = await cid("other archive");
    expect(() => parseCountyTablesV1(input, otherRoot)).toThrow("county_root");
  });

  it("rejects table row totals and duplicate part CIDs", async () => {
    const input = await countyTables();
    const duplicateCid = input.tables.property_improvement.parts[0].cid;
    const invalid = {
      ...input,
      tables: {
        ...input.tables,
        property_improvement: {
          rows: 4,
          parts: [
            input.tables.property_improvement.parts[0],
            {
              ...input.tables.property_improvement.parts[1],
              cid: duplicateCid,
            },
          ],
        },
      },
    };
    const result = CountyTablesV1Schema.safeParse(invalid);

    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(
        messages.some((message) => message.includes("declares 4 rows")),
      ).toBe(true);
      expect(
        messages.some((message) => message.includes("duplicate part CID")),
      ).toBe(true);
    }
  });

  it("rejects invalid table identifiers, codec, versions, rows, and bytes", async () => {
    const input = await countyTables();
    const table = input.tables.property_improvement;

    expect(
      CountyTablesV1Schema.safeParse({ ...input, version: 2 }).success,
    ).toBe(false);
    expect(
      CountyTablesV1Schema.safeParse({ ...input, codec: "gzip" }).success,
    ).toBe(false);
    expect(
      CountyTablesV1Schema.safeParse({
        ...input,
        tables: { "Property Improvement": table },
      }).success,
    ).toBe(false);
    expect(
      CountyTablesV1Schema.safeParse({
        ...input,
        tables: {
          property_improvement: {
            rows: 0.5,
            parts: [{ ...table.parts[0], rows: 0.5, bytes: 0 }],
          },
        },
      }).success,
    ).toBe(false);
  });
});
