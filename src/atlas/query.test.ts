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

      const result = await runAtlasQuery({
        county: "lee",
        dataGroup: "county",
        table: "property",
        sql: `SELECT parcel_identifier, market_value
              FROM properties
              WHERE market_value > 100000`,
        limit: 10,
      });
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
        await runAtlasQuery({
          county: "lee",
          dataGroup: "hoa",
          table: "property",
          sql: "SELECT * FROM properties",
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
