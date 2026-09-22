import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseAtlasDatabaseUrl } from "../atlas/backend.ts";
import { openAtlasConnections } from "../atlas/connections.ts";
import {
  resetAtlasRuntimeForTests,
  setAtlasRuntimeForTests,
} from "../atlas/runtime.ts";
import { initializeAtlasSchema } from "../atlas/schema.ts";
import {
  findPropertiesInAreaHandler,
  sumPropertyValueInAreaHandler,
} from "./atlasGeo.ts";

const directories: string[] = [];

afterEach(async () => {
  resetAtlasRuntimeForTests();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const scope = {
  county: "lee",
  dataGroup: "county",
  table: "property",
  latitudeColumn: "latitude",
  longitudeColumn: "longitude",
  parcelColumn: "parcel_identifier",
  valueColumn: "avm_value",
  bbox: { minLat: 26, minLng: -82, maxLat: 27, maxLng: -81 },
};

describe("Atlas geo tools", () => {
  it("uses explicit table and column names and lists columns on a miss", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-geo-"));
    directories.push(directory);
    const backend = parseAtlasDatabaseUrl(
      `file://${path.join(directory, "atlas.sqlite")}`,
    );
    const connections = await openAtlasConnections(backend);
    try {
      await initializeAtlasSchema(connections.write);
      await connections.write.execute(
        `INSERT INTO atlas_state VALUES
         ('lee', 'FL', '12071', 'county', 'a', 't', 's', 'p', 'l')`,
      );
      await connections.write.execute(
        "INSERT INTO atlas_sync_state VALUES (1, 'index', 'from', 'now')",
      );
      await connections.write.execute(
        `CREATE TABLE property (
          county TEXT, data_group TEXT, cid TEXT, property_cid TEXT,
          parcel_identifier TEXT, latitude REAL, longitude REAL,
          avm_value BIGINT,
          PRIMARY KEY (county, data_group, cid, property_cid)
        )`,
      );
      await connections.write.execute(
        `INSERT INTO property VALUES
         ('lee', 'county', 'c1', 'p1', 'parcel-1', 26.5, -81.5, 100),
         ('lee', 'county', 'c2', 'p2', 'parcel-2', 28.0, -81.5, 200),
         ('lee', 'hoa', 'c3', 'p3', 'parcel-3', 26.5, -81.5, 400)`,
      );
      setAtlasRuntimeForTests({ backend, connections, status: "ready" });

      expect(parse(await findPropertiesInAreaHandler(scope))).toMatchObject({
        count: 1,
        parcels: [{ parcel_identifier: "parcel-1", value: 100 }],
      });
      expect(parse(await sumPropertyValueInAreaHandler(scope))).toMatchObject({
        count: 1,
        totalValue: 100,
      });
      expect(
        parse(
          await findPropertiesInAreaHandler({
            ...scope,
            valueColumn: "market_value",
          }),
        ).details,
      ).toBe(
        "Column 'market_value' does not exist; available columns: county, data_group, cid, property_cid, parcel_identifier, latitude, longitude, avm_value",
      );
      expect(
        parse(await findPropertiesInAreaHandler({ ...scope, table: "address" }))
          .details,
      ).toContain("not synchronized");
    } finally {
      await connections.close();
    }
  });
});
