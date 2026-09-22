import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseAtlasDatabaseUrl } from "./backend.ts";
import { openAtlasConnections, type AtlasConnections } from "./connections.ts";
import {
  awaitAtlasReady,
  resetAtlasRuntimeForTests,
  setAtlasRuntimeForTests,
  type AtlasRuntime,
} from "./runtime.ts";
import { initializeAtlasSchema } from "./schema.ts";
import type { AtlasSyncSummary } from "./sync.ts";

const directories: string[] = [];

afterEach(async () => {
  resetAtlasRuntimeForTests();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function open(): Promise<AtlasRuntime> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-runtime-"));
  directories.push(directory);
  const backend = parseAtlasDatabaseUrl(
    `file://${path.join(directory, "atlas.sqlite")}`,
  );
  const connections = await openAtlasConnections(backend);
  await initializeAtlasSchema(connections.write);
  return { backend, connections, status: "syncing" };
}

function accept(connections: AtlasConnections) {
  return connections.write.execute(
    `INSERT INTO atlas_sync_state VALUES (1, 'index', 'from', 'now')`,
  );
}

describe("Atlas runtime readiness", () => {
  it("serves the accepted snapshot while a sync is still running", async () => {
    const runtime = await open();
    try {
      await accept(runtime.connections);
      runtime.sync = new Promise<AtlasSyncSummary>(() => undefined);
      setAtlasRuntimeForTests(runtime);

      await expect(awaitAtlasReady()).resolves.toBe(runtime);
    } finally {
      await runtime.connections.close();
    }
  });

  it("waits for the first sync when no snapshot exists", async () => {
    const runtime = await open();
    try {
      runtime.sync = accept(runtime.connections).then(() => {
        runtime.status = "ready";
        return {} as AtlasSyncSummary;
      });
      setAtlasRuntimeForTests(runtime);

      await expect(awaitAtlasReady()).resolves.toMatchObject({
        status: "ready",
      });

      runtime.status = "syncing";
      runtime.sync = Promise.reject(new Error("gateway down"));
      await runtime.connections.write.execute("DELETE FROM atlas_sync_state");
      runtime.sync.catch(() => {
        runtime.status = "error";
        runtime.error = "gateway down";
      });
      await expect(awaitAtlasReady()).rejects.toThrow(
        "ATLAS_NOT_INITIALIZED: gateway down",
      );
    } finally {
      await runtime.connections.close();
    }
  });
});
