import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseAtlasDatabaseUrl } from "./backend.ts";
import { openAtlasConnections } from "./connections.ts";
import { initializeAtlasSchema } from "./schema.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Atlas control schema", () => {
  it("initializes separately from the embeddings database", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-schema-"));
    directories.push(directory);
    const connections = await openAtlasConnections(
      parseAtlasDatabaseUrl(`file://${path.join(directory, "atlas.sqlite")}`),
    );

    try {
      await initializeAtlasSchema(connections.write);
      const tables = await connections.read(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
         ORDER BY name`,
      );

      expect(tables.map((row) => row.name)).toEqual([
        "atlas_state",
        "atlas_sync_state",
      ]);
      expect(tables.map((row) => row.name)).not.toContain("functionEmbeddings");
    } finally {
      await connections.close();
    }
  });

  it("can initialize repeatedly", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-schema-"));
    directories.push(directory);
    const connections = await openAtlasConnections(
      parseAtlasDatabaseUrl(`file://${path.join(directory, "atlas.sqlite")}`),
    );

    try {
      await initializeAtlasSchema(connections.write);
      await expect(
        initializeAtlasSchema(connections.write),
      ).resolves.toBeUndefined();
    } finally {
      await connections.close();
    }
  });
});
