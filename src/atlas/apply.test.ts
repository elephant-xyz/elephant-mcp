import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyAtlasIndexTransaction } from "./apply.ts";
import { parseAtlasDatabaseUrl } from "./backend.ts";
import { openAtlasConnections, type AtlasConnections } from "./connections.ts";
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
  { name: "property_cid", canonicalType: "text", sourceType: "VARCHAR" },
  { name: "data_group_cid", canonicalType: "text", sourceType: "VARCHAR" },
  { name: "name", canonicalType: "text", sourceType: "VARCHAR" },
] as const;

async function stage(
  connections: AtlasConnections,
  table: string,
  rows: Array<[string, string, string, string]>,
) {
  await connections.write.execute(
    `CREATE TABLE ${table} (
      cid TEXT,
      property_cid TEXT,
      data_group_cid TEXT,
      name TEXT
    )`,
  );
  for (const row of rows) {
    await connections.write.execute(
      `INSERT INTO ${table} VALUES (?, ?, ?, ?)`,
      row,
    );
  }
}

function apply(
  connections: AtlasConnections,
  indexCid: string,
  groups: Array<{ dataGroup: string; stageTable: string }>,
  withdrawals: string[] = [],
) {
  return connections.transaction((executor) =>
    applyAtlasIndexTransaction({
      backend: "sqlite",
      executor,
      generatedFrom: `generated-${indexCid}`,
      groups: groups.map(({ dataGroup, stageTable }) => ({
        group: group(dataGroup),
        tables: [
          { columns: [...columns], name: "company", rows: 1, stageTable },
        ],
      })),
      indexCid,
      withdrawals: withdrawals.map((dataGroup) => ({
        action: "withdraw",
        county: "lee",
        dataGroup,
      })),
    }),
  );
}

describe("Atlas index transaction", () => {
  it("scopes shared content per group and withdraws by scope", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-apply-"));
    directories.push(directory);
    const connections = await openAtlasConnections(
      parseAtlasDatabaseUrl(`file://${path.join(directory, "atlas.sqlite")}`),
    );
    try {
      await initializeAtlasSchema(connections.write);
      await stage(connections, "atlas_stage__county", [
        ["shared-cid", "property-a", "county-schema", "Shared"],
        ["shared-cid", "property-b", "county-schema", "Shared"],
      ]);
      await stage(connections, "atlas_stage__hoa", [
        ["shared-cid", "property-c", "hoa-schema", "Shared"],
      ]);
      await apply(connections, INDEX, [
        { dataGroup: "county", stageTable: "atlas_stage__county" },
        { dataGroup: "hoa", stageTable: "atlas_stage__hoa" },
      ]);
      expect(
        await connections.read(
          "SELECT data_group, property_cid FROM company ORDER BY property_cid",
        ),
      ).toEqual([
        { data_group: "county", property_cid: "property-a" },
        { data_group: "county", property_cid: "property-b" },
        { data_group: "hoa", property_cid: "property-c" },
      ]);

      await stage(connections, "atlas_stage__changed", [
        ["shared-cid", "property-c", "hoa-schema", "Changed"],
      ]);
      await apply(connections, `${INDEX.slice(0, -1)}c`, [
        { dataGroup: "hoa", stageTable: "atlas_stage__changed" },
      ]);
      expect(
        await connections.read(
          "SELECT name FROM company WHERE data_group = 'hoa'",
        ),
      ).toEqual([{ name: "Changed" }]);

      await apply(connections, `${INDEX.slice(0, -1)}a`, [], ["county"]);
      expect(await connections.read("SELECT data_group FROM company")).toEqual([
        { data_group: "hoa" },
      ]);
      expect(
        await connections.read("SELECT data_group FROM atlas_state"),
      ).toEqual([{ data_group: "hoa" }]);

      await apply(connections, `${INDEX.slice(0, -1)}b`, [], ["hoa"]);
      expect(
        await connections.read("SELECT count(*) AS count FROM company"),
      ).toEqual([{ count: 0 }]);
    } finally {
      await connections.close();
    }
  });
});
