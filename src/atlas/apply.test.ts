import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyAtlasIndexTransaction } from "./apply.ts";
import { parseAtlasDatabaseUrl } from "./backend.ts";
import { openAtlasConnections } from "./connections.ts";
import type { AtlasGroupTarget } from "./plan.ts";
import { initializeAtlasSchema } from "./schema.ts";

const directories: string[] = [];
const INDEX = "bafkreici4fnvhn42zqyxb4ltlrocldghfagnbxhzgjkbck546t6cm6mtky";

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function group(dataGroup: string): AtlasGroupTarget {
  return {
    action: "load",
    county: "lee",
    state: "FL",
    fips: "12071",
    dataGroup,
    archiveCid: `${dataGroup}-archive`,
    tablesCid: `${dataGroup}-tables`,
    schemaCid: `${dataGroup}-schema`,
    publishedAt: "2026-09-21T17:23:52.000Z",
  };
}

const columns = [
  { name: "cid", canonicalType: "text", sourceType: "VARCHAR" },
  {
    name: "property_cid",
    canonicalType: "text",
    sourceType: "VARCHAR",
  },
  {
    name: "data_group_cid",
    canonicalType: "text",
    sourceType: "VARCHAR",
  },
  { name: "name", canonicalType: "text", sourceType: "VARCHAR" },
] as const;

describe("Atlas index transaction", () => {
  it("preserves content shared by another group during withdrawal", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-apply-"));
    directories.push(directory);
    const connections = await openAtlasConnections(
      parseAtlasDatabaseUrl(`file://${path.join(directory, "atlas.sqlite")}`),
    );
    try {
      await initializeAtlasSchema(connections.write);
      for (const [stage, property, schema] of [
        ["stage_county", "property-a", "county-schema"],
        ["stage_hoa", "property-b", "hoa-schema"],
      ]) {
        await connections.write.execute(
          `CREATE TABLE ${stage} (
            cid TEXT,
            property_cid TEXT,
            data_group_cid TEXT,
            name TEXT
          )`,
        );
        await connections.write.execute(
          `INSERT INTO ${stage}
           (cid, property_cid, data_group_cid, name)
           VALUES (?, ?, ?, ?)`,
          ["shared-cid", property, schema, "Shared"],
        );
      }

      await connections.transaction((executor) =>
        applyAtlasIndexTransaction({
          backend: "sqlite",
          executor,
          generatedFrom: "generated-a",
          groups: [
            {
              group: group("county"),
              tables: [
                {
                  columns: [...columns],
                  logicalName: "company",
                  rows: 1,
                  stageTable: "stage_county",
                },
              ],
            },
            {
              group: group("hoa"),
              tables: [
                {
                  columns: [...columns],
                  logicalName: "company",
                  rows: 1,
                  stageTable: "stage_hoa",
                },
              ],
            },
          ],
          indexCid: INDEX,
          withdrawals: [],
        }),
      );

      expect(
        await connections.read(
          "SELECT count(*) AS count FROM atlas_content__company",
        ),
      ).toEqual([{ count: 1 }]);
      expect(
        await connections.read(
          "SELECT count(*) AS count FROM atlas_membership",
        ),
      ).toEqual([{ count: 2 }]);

      await connections.write.execute(
        `CREATE TABLE stage_conflict (
          cid TEXT,
          property_cid TEXT,
          data_group_cid TEXT,
          name TEXT
        )`,
      );
      await connections.write.execute(
        `INSERT INTO stage_conflict
         VALUES ('shared-cid', 'property-c', 'hoa-schema', 'Changed')`,
      );
      await connections.transaction((executor) =>
        applyAtlasIndexTransaction({
          backend: "sqlite",
          executor,
          generatedFrom: "generated-conflict",
          groups: [
            {
              group: group("hoa"),
              tables: [
                {
                  columns: [...columns],
                  logicalName: "company",
                  rows: 1,
                  stageTable: "stage_conflict",
                },
              ],
            },
          ],
          indexCid: `${INDEX.slice(0, -1)}c`,
          withdrawals: [],
        }),
      );
      expect(
        await connections.read(`SELECT name FROM atlas_content__company`),
      ).toEqual([{ name: "Changed" }]);
      expect(
        await connections.read(
          "SELECT count(*) AS count FROM atlas_membership",
        ),
      ).toEqual([{ count: 2 }]);

      await connections.transaction((executor) =>
        applyAtlasIndexTransaction({
          backend: "sqlite",
          executor,
          generatedFrom: "generated-b",
          groups: [],
          indexCid: `${INDEX.slice(0, -1)}a`,
          withdrawals: [
            { action: "withdraw", county: "lee", dataGroup: "county" },
          ],
        }),
      );

      expect(
        await connections.read(
          "SELECT count(*) AS count FROM atlas_content__company",
        ),
      ).toEqual([{ count: 1 }]);
      expect(
        await connections.read("SELECT data_group FROM atlas_membership"),
      ).toEqual([{ data_group: "hoa" }]);

      await connections.transaction((executor) =>
        applyAtlasIndexTransaction({
          backend: "sqlite",
          executor,
          generatedFrom: "generated-c",
          groups: [],
          indexCid: `${INDEX.slice(0, -1)}b`,
          withdrawals: [
            { action: "withdraw", county: "lee", dataGroup: "hoa" },
          ],
        }),
      );
      expect(
        await connections.read(
          "SELECT count(*) AS count FROM atlas_content__company",
        ),
      ).toEqual([{ count: 0 }]);
    } finally {
      await connections.close();
    }
  });
});
