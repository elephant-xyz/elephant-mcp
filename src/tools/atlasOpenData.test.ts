import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseAtlasDatabaseUrl } from "../atlas/backend.ts";
import { openAtlasConnections } from "../atlas/connections.ts";
import { setAtlasRuntimeForTests } from "../atlas/runtime.ts";
import { initializeAtlasSchema } from "../atlas/schema.ts";
import { getOracleDatasetInfoHandler } from "./atlasOpenData.ts";

const directories: string[] = [];

afterEach(async () => {
  setAtlasRuntimeForTests();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("getOracleDatasetInfo", () => {
  it("reports state, fips, sync time, and table counts from the scoped rows", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-info-"));
    directories.push(directory);
    const backend = parseAtlasDatabaseUrl(
      `file://${path.join(directory, "atlas.sqlite")}`,
    );
    const connections = await openAtlasConnections(backend);
    try {
      await initializeAtlasSchema(connections.write);
      await connections.write.execute(
        `INSERT INTO atlas_state VALUES
         ('orange', 'FL', '12095', 'county', 'a', 't', 's', 'p', 'l'),
         ('orange', 'CA', '06059', 'county', 'b', 'u', 'v', 'q', 'm')`,
      );
      await connections.write.execute(
        "INSERT INTO atlas_sync_state VALUES (1, 'index', 'from', 'synced')",
      );
      await connections.write.execute(
        `CREATE TABLE property (
          state TEXT, county TEXT, data_group TEXT, cid TEXT, property_cid TEXT,
          PRIMARY KEY (state, county, data_group, cid)
        )`,
      );
      await connections.write.execute(
        `INSERT INTO property VALUES
         ('FL', 'orange', 'county', 'c1', 'p1'),
         ('CA', 'orange', 'county', 'c2', 'p2'),
         ('CA', 'orange', 'county', 'c3', 'p3')`,
      );
      setAtlasRuntimeForTests({ backend, connections, status: "ready" });

      const result = await getOracleDatasetInfoHandler({
        county: "orange",
        dataGroup: "county",
        state: "CA",
      });
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        county: "orange",
        state: "CA",
        fips: "06059",
        syncedAt: "synced",
        tables: [{ tableName: "property", rows: 2 }],
        source: { archiveCid: "b", state: "CA" },
      });
    } finally {
      await connections.close();
    }
  });
});
