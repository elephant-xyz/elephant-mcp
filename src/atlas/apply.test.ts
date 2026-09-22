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

type Row = [string, string, string, string];

function rows(...values: Row[]): Array<Record<string, unknown>> {
  return values.map(([cid, property_cid, data_group_cid, name]) => ({
    cid,
    property_cid,
    data_group_cid,
    name,
  }));
}

function apply(
  connections: AtlasConnections,
  indexCid: string,
  groups: Array<{ dataGroup: string; rows: Array<Record<string, unknown>> }>,
  withdrawals: string[] = [],
) {
  return connections.transaction((executor) =>
    applyAtlasIndexTransaction({
      backend: "sqlite",
      executor,
      generatedFrom: `generated-${indexCid}`,
      groups: groups.map(({ dataGroup, rows }) => ({
        group: group(dataGroup),
        tables: [
          {
            columns: [...columns],
            name: "company",
            rows: rows.length,
            async *read() {
              yield* rows;
            },
          },
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
      await apply(connections, INDEX, [
        {
          dataGroup: "county",
          rows: rows(
            ["shared-cid", "property-a", "county-schema", "Shared"],
            ["other-cid", "property-b", "county-schema", "Other"],
          ),
        },
        {
          dataGroup: "hoa",
          rows: rows(["shared-cid", "property-c", "hoa-schema", "Shared"]),
        },
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

      await apply(connections, `${INDEX.slice(0, -1)}c`, [
        {
          dataGroup: "hoa",
          rows: rows(["shared-cid", "property-c", "hoa-schema", "Changed"]),
        },
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

      await expect(
        apply(connections, `${INDEX.slice(0, -1)}d`, [
          { dataGroup: "hoa", rows: [] },
        ]).catch((error: Error) => error.message),
      ).resolves.toBeUndefined();
      await expect(
        connections.transaction((executor) =>
          applyAtlasIndexTransaction({
            backend: "sqlite",
            executor,
            generatedFrom: "short",
            groups: [
              {
                group: group("hoa"),
                tables: [
                  {
                    columns: [...columns],
                    name: "company",
                    rows: 2,
                    async *read() {
                      yield* rows(["c", "p", "s", "n"]);
                    },
                  },
                ],
              },
            ],
            indexCid: `${INDEX.slice(0, -1)}e`,
            withdrawals: [],
          }),
        ),
      ).rejects.toThrow("loaded 1 rows, expected 2");
    } finally {
      await connections.close();
    }
  });
});
