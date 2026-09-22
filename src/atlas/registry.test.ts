import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseAtlasDatabaseUrl } from "./backend.ts";
import { openAtlasConnections } from "./connections.ts";
import {
  describeAtlasContentTable,
  ensureAtlasContentTable,
  type AtlasParquetColumn,
} from "./registry.ts";
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

describe("Atlas content table registry", () => {
  it("classifies producer table shapes", () => {
    expect(describeAtlasContentTable("property", baseColumns)).toMatchObject({
      kind: "entity",
      physicalName: "atlas_content__property",
      primaryKey: "cid",
    });
    expect(
      describeAtlasContentTable("property_has_address", [
        column("relationship_cid"),
        column("from_cid"),
        column("to_cid"),
        column("property_cid"),
        column("data_group_cid"),
      ]),
    ).toMatchObject({
      kind: "relationship",
      primaryKey: "relationship_cid",
    });
    expect(
      describeAtlasContentTable("properties", [column("property_cid")]),
    ).toBeNull();
  });

  it("rejects ambiguous producer table shapes", () => {
    expect(() =>
      describeAtlasContentTable("broken", [
        column("cid"),
        column("relationship_cid"),
        column("property_cid"),
        column("data_group_cid"),
      ]),
    ).toThrow("exactly one");
  });

  it("creates and evolves a SQLite content table", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-registry-"));
    directories.push(directory);
    const connections = await openAtlasConnections(
      parseAtlasDatabaseUrl(`file://${path.join(directory, "atlas.sqlite")}`),
    );
    try {
      await initializeAtlasSchema(connections.write);
      const initial = describeAtlasContentTable("property", baseColumns)!;
      expect(
        await ensureAtlasContentTable(
          connections.write,
          "sqlite",
          initial,
          INDEX,
        ),
      ).toEqual(["cid", "request_identifier", "market_value"]);

      const evolved = describeAtlasContentTable("property", [
        ...baseColumns,
        column("historic", "boolean"),
      ])!;
      expect(
        await ensureAtlasContentTable(
          connections.write,
          "sqlite",
          evolved,
          INDEX,
        ),
      ).toEqual(["historic"]);

      const columns = await connections.read(
        `PRAGMA table_info("atlas_content__property")`,
      );
      expect(columns.map((row) => row.name)).toEqual([
        "cid",
        "request_identifier",
        "market_value",
        "historic",
      ]);
    } finally {
      await connections.close();
    }
  });

  it("rejects incompatible column evolution", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-registry-"));
    directories.push(directory);
    const connections = await openAtlasConnections(
      parseAtlasDatabaseUrl(`file://${path.join(directory, "atlas.sqlite")}`),
    );
    try {
      await initializeAtlasSchema(connections.write);
      const initial = describeAtlasContentTable("property", baseColumns)!;
      await ensureAtlasContentTable(
        connections.write,
        "sqlite",
        initial,
        INDEX,
      );
      const changed = describeAtlasContentTable("property", [
        ...baseColumns.slice(0, -1),
        column("market_value", "text"),
      ])!;

      await expect(
        ensureAtlasContentTable(connections.write, "sqlite", changed, INDEX),
      ).rejects.toThrow("changed from double to text");
    } finally {
      await connections.close();
    }
  });
});
