import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyAtlasIndexTransaction } from "./apply.ts";
import { parseAtlasDatabaseUrl } from "./backend.ts";
import { openAtlasConnections } from "./connections.ts";
import {
  getAtlasProperty,
  getAtlasQuerySchema,
  listAtlasCounties,
  listAtlasProperties,
  runAtlasQuery,
} from "./query.ts";
import {
  resetAtlasRuntimeForTests,
  setAtlasRuntimeForTests,
} from "./runtime.ts";
import { initializeAtlasSchema } from "./schema.ts";

const directories: string[] = [];
const INDEX = "bafkreici4fnvhn42zqyxb4ltlrocldghfagnbxhzgjkbck546t6cm6mtky";

afterEach(async () => {
  resetAtlasRuntimeForTests();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const text = (name: string) =>
  ({ name, canonicalType: "text", sourceType: "VARCHAR" }) as const;

describe("Atlas query repository", () => {
  it("queries one scoped table with provenance", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-query-"));
    directories.push(directory);
    const backend = parseAtlasDatabaseUrl(
      `file://${path.join(directory, "atlas.sqlite")}`,
    );
    const connections = await openAtlasConnections(backend);
    try {
      await initializeAtlasSchema(connections.write);
      await connections.write.execute(
        `CREATE TABLE atlas_stage__property (
          cid TEXT,
          property_cid TEXT,
          data_group_cid TEXT,
          parcel_identifier TEXT,
          market_value BIGINT
        )`,
      );
      await connections.write.execute(
        `INSERT INTO atlas_stage__property
         VALUES ('entity-cid', 'property-cid', 'schema-cid', 'parcel-1', 125000)`,
      );
      await connections.write.execute(
        "CREATE TABLE atlas_stage__properties (property_cid TEXT, bafkreischema TEXT)",
      );
      await connections.write.execute(
        "INSERT INTO atlas_stage__properties VALUES ('property-cid', 'root-cid')",
      );
      await connections.transaction((executor) =>
        applyAtlasIndexTransaction({
          backend: "sqlite",
          executor,
          generatedFrom: "generated",
          groups: [
            {
              group: {
                action: "load",
                county: "lee",
                state: "FL",
                fips: "12071",
                dataGroup: "county",
                archiveCid: "archive-cid",
                tablesCid: "tables-cid",
                schemaCid: "schema-cid",
                publishedAt: "2026-09-21T17:23:52.000Z",
              },
              tables: [
                {
                  columns: [
                    text("cid"),
                    text("property_cid"),
                    text("data_group_cid"),
                    text("parcel_identifier"),
                    {
                      name: "market_value",
                      canonicalType: "int64",
                      sourceType: "BIGINT",
                    },
                  ],
                  name: "property",
                  rows: 1,
                  stageTable: "atlas_stage__property",
                },
                {
                  columns: [text("property_cid"), text("bafkreischema")],
                  name: "properties",
                  rows: 1,
                  stageTable: "atlas_stage__properties",
                },
              ],
            },
          ],
          indexCid: INDEX,
          withdrawals: [],
        }),
      );
      setAtlasRuntimeForTests({
        backend,
        connections,
        status: "ready",
      });

      // A row from another scope must never be visible.
      await connections.write.execute(
        `INSERT INTO property VALUES
         ('lee', 'hoa', 'other-cid', 'other-property', 'hoa-schema', 'parcel-9', 1)`,
      );
      const query = (sql: string) =>
        runAtlasQuery({ county: "lee", dataGroup: "county", sql, limit: 10 });

      const result = await query(
        `SELECT parcel_identifier, market_value
         FROM property
         WHERE market_value > 100000`,
      );
      expect(result).toMatchObject({
        rowCount: 1,
        rows: [{ parcel_identifier: "parcel-1", market_value: 125000 }],
        source: {
          county: "lee",
          dataGroup: "county",
          archiveCid: "archive-cid",
          indexCid: INDEX,
        },
      });
      expect(
        (
          await query(
            `SELECT count(*) AS n, p.bafkreischema AS root
             FROM property AS c
             JOIN properties p ON p.property_cid = c.property_cid
             GROUP BY p.bafkreischema`,
          )
        ).rows,
      ).toEqual([{ n: 1, root: "root-cid" }]);
      expect(
        (await query("WITH x AS (SELECT * FROM property) SELECT cid FROM x"))
          .rows,
      ).toEqual([{ cid: "entity-cid" }]);

      const rejected = (sql: string) =>
        query(sql).then(
          () => "accepted",
          (error: Error) => error.message,
        );
      expect(await rejected("SELECT * FROM property, atlas_state")).toContain(
        "atlas_state",
      );
      expect(
        await rejected(
          "SELECT * FROM (SELECT index_cid FROM atlas_sync_state) AS s",
        ),
      ).toContain("atlas_sync_state");
      expect(
        await rejected(
          "WITH property AS (SELECT * FROM atlas_state) SELECT * FROM property",
        ),
      ).toContain("atlas_state");
      expect(await rejected('SELECT * FROM "atlas_state"')).toContain(
        "atlas_state",
      );
      expect(await rejected("SELECT * FROM main.property")).toContain("main");
      expect(await rejected("SELECT * FROM sqlite_master")).toContain(
        "sqlite_master",
      );
      expect(await rejected("SELECT * FROM atlas_stage__x")).toContain(
        "atlas_stage__x",
      );
      expect(await rejected("SELECT * FROM unknown_table")).toContain(
        "unknown_table",
      );
      expect(
        await runAtlasQuery({
          county: "lee",
          dataGroup: "hoa",
          sql: "SELECT * FROM property",
          limit: 10,
        }).catch((error: Error) => error.message),
      ).toContain("not published");

      expect(
        await getAtlasQuerySchema({ county: "lee", dataGroup: "county" }),
      ).toMatchObject({
        tables: [
          {
            tableName: "properties",
            primaryKeyColumn: "property_cid",
            rows: 1,
          },
          { tableName: "property", primaryKeyColumn: "cid", rows: 1 },
        ],
      });
      expect(
        await getAtlasQuerySchema({
          county: "lee",
          dataGroup: "county",
          table: "property",
        }),
      ).toMatchObject({
        table: "property",
        columns: expect.arrayContaining([
          { name: "market_value", type: "bigint" },
          { name: "property_cid", type: "text" },
        ]),
      });
      expect(await listAtlasCounties()).toMatchObject({
        countyCount: 1,
        indexCid: INDEX,
      });
      expect(
        await listAtlasProperties({
          county: "lee",
          dataGroup: "county",
          limit: 10,
          offset: 0,
        }),
      ).toMatchObject({
        total: 1,
        properties: [
          { property_cid: "property-cid", bafkreischema: "root-cid" },
        ],
      });
      expect(
        await getAtlasProperty({
          county: "lee",
          dataGroup: "county",
          propertyCid: "property-cid",
        }),
      ).toMatchObject({
        propertyCid: "property-cid",
        records: {
          properties: [{ bafkreischema: "root-cid" }],
          property: [{ cid: "entity-cid", parcel_identifier: "parcel-1" }],
        },
      });
      await expect(
        getAtlasProperty({
          county: "lee",
          dataGroup: "county",
          propertyCid: "missing",
        }),
      ).rejects.toThrow("CID_NOT_PUBLISHED");
    } finally {
      await connections.close();
    }
  });
});
