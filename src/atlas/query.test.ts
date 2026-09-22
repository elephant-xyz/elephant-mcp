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

describe("Atlas query repository", () => {
  it("queries one scoped normalized table with provenance", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-query-"));
    directories.push(directory);
    const backend = parseAtlasDatabaseUrl(
      `file://${path.join(directory, "atlas.sqlite")}`,
    );
    const connections = await openAtlasConnections(backend);
    try {
      await initializeAtlasSchema(connections.write);
      await connections.write.execute(
        `CREATE TABLE stage_property (
          cid TEXT,
          property_cid TEXT,
          data_group_cid TEXT,
          parcel_identifier TEXT,
          market_value BIGINT
        )`,
      );
      await connections.write.execute(
        `INSERT INTO stage_property
         VALUES ('entity-cid', 'property-cid', 'schema-cid', 'parcel-1', 125000)`,
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
                    {
                      name: "cid",
                      canonicalType: "text",
                      sourceType: "VARCHAR",
                    },
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
                    {
                      name: "parcel_identifier",
                      canonicalType: "text",
                      sourceType: "VARCHAR",
                    },
                    {
                      name: "market_value",
                      canonicalType: "int64",
                      sourceType: "BIGINT",
                    },
                  ],
                  logicalName: "property",
                  rows: 1,
                  stageTable: "stage_property",
                },
              ],
            },
          ],
          indexCid: INDEX,
          withdrawals: [],
        }),
      );
      await connections.write.execute(
        `INSERT INTO atlas_property_roots
         VALUES (
           'lee',
           'county',
           'property-cid',
           'schema-cid',
           'root-cid',
           'archive-cid',
           'tables-cid'
         )`,
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
        rows: [
          {
            parcel_identifier: "parcel-1",
            market_value: 125000,
          },
        ],
        source: {
          county: "lee",
          dataGroup: "county",
          archiveCid: "archive-cid",
          indexCid: INDEX,
        },
      });
      await expect(
        runAtlasQuery({
          county: "lee",
          dataGroup: "county",
          table: "property",
          sql: "SELECT * FROM atlas_state",
          limit: 10,
        }),
      ).rejects.toThrow("logical properties relation");

      expect(
        await getAtlasQuerySchema({
          county: "lee",
          dataGroup: "county",
          table: "property",
        }),
      ).toMatchObject({
        table: "property",
        columns: expect.arrayContaining([
          { name: "market_value", type: "int64" },
          { name: "property_cid", type: "text" },
        ]),
      });
      expect(await listAtlasCounties()).toMatchObject({
        countyCount: 1,
        indexCid: INDEX,
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
          property: [
            {
              cid: "entity-cid",
              parcel_identifier: "parcel-1",
            },
          ],
        },
        roots: [{ root_cid: "root-cid" }],
      });
    } finally {
      await connections.close();
    }
  });
});
