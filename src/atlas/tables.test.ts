import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseAtlasDatabaseUrl } from "./backend.ts";
import { openAtlasConnections } from "./connections.ts";
import {
  atlasKeyColumns,
  describeAtlasTable,
  ensureAtlasTable,
  readAtlasCatalog,
  type AtlasParquetColumn,
} from "./tables.ts";
import { initializeAtlasSchema } from "./schema.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function column(
  name: string,
  canonicalType: AtlasParquetColumn["canonicalType"] = "text",
): AtlasParquetColumn {
  return { canonicalType, name, sourceType: canonicalType };
}

const baseColumns = [
  column("cid"),
  column("property_cid"),
  column("data_group_cid"),
  column("request_identifier"),
  column("market_value", "double"),
];

describe("Atlas content tables", () => {
  it("classifies producer table shapes and their keys", () => {
    const property = describeAtlasTable("property", baseColumns);
    expect(property.primaryKey).toBe("cid");
    expect(atlasKeyColumns(property)).toEqual(["county", "data_group", "cid"]);
    expect(
      describeAtlasTable("property_has_address", [
        column("relationship_cid"),
        column("from_cid"),
        column("to_cid"),
        column("property_cid"),
        column("data_group_cid"),
      ]).primaryKey,
    ).toBe("relationship_cid");
    const properties = describeAtlasTable("properties", [
      column("property_cid"),
      column("bafkreischema"),
    ]);
    expect(atlasKeyColumns(properties)).toEqual([
      "county",
      "data_group",
      "property_cid",
    ]);
  });

  it("rejects ambiguous shapes and reserved names", () => {
    expect(() =>
      describeAtlasTable("broken", [
        column("cid"),
        column("relationship_cid"),
        column("property_cid"),
        column("data_group_cid"),
      ]),
    ).toThrow("exactly one");
    expect(() => describeAtlasTable("atlas_state", baseColumns)).toThrow(
      "Invalid Atlas table identifier",
    );
  });

  it("creates and evolves a SQLite table from the catalog", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-tables-"));
    directories.push(directory);
    const connections = await openAtlasConnections(
      parseAtlasDatabaseUrl(`file://${path.join(directory, "atlas.sqlite")}`),
    );
    try {
      await initializeAtlasSchema(connections.write);
      await ensureAtlasTable(
        connections.write,
        "sqlite",
        describeAtlasTable("property", baseColumns),
      );
      await ensureAtlasTable(
        connections.write,
        "sqlite",
        describeAtlasTable("property", [
          ...baseColumns,
          column("historic", "boolean"),
        ]),
      );

      const catalog = await readAtlasCatalog(connections.read, "sqlite");
      expect([...catalog.keys()]).toEqual(["property"]);
      expect(catalog.get("property")).toEqual([
        { name: "county", type: "text" },
        { name: "data_group", type: "text" },
        { name: "cid", type: "text" },
        { name: "property_cid", type: "text" },
        { name: "data_group_cid", type: "text" },
        { name: "request_identifier", type: "text" },
        { name: "market_value", type: "real" },
        { name: "historic", type: "boolean" },
      ]);

      await expect(
        ensureAtlasTable(
          connections.write,
          "sqlite",
          describeAtlasTable("property", [
            ...baseColumns.slice(0, -1),
            column("market_value", "text"),
          ]),
        ),
      ).rejects.toThrow("changed from real to text");
    } finally {
      await connections.close();
    }
  });
});
