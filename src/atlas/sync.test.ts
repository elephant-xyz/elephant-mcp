import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseAtlasDatabaseUrl } from "./backend.ts";
import { openAtlasConnections, type AtlasConnections } from "./connections.ts";
import { acquireAtlasSyncLock } from "./locks.ts";
import { syncAtlas } from "./sync.ts";

const opened = vi.hoisted(() => [] as AtlasConnections[]);

vi.mock("./connections.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./connections.ts")>();
  return {
    ...actual,
    async openAtlasConnections(
      backend: Parameters<typeof actual.openAtlasConnections>[0],
    ) {
      const connections = await actual.openAtlasConnections(backend);
      vi.spyOn(connections, "close");
      opened.push(connections);
      return connections;
    },
  };
});

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Atlas synchronization", () => {
  it("records an empty index and performs no writes on a rerun", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-sync-"));
    directories.push(directory);
    const databaseUrl = `file://${path.join(directory, "atlas.sqlite")}`;
    const connections = await openAtlasConnections(
      parseAtlasDatabaseUrl(databaseUrl),
    );
    const body = JSON.stringify({
      version: 1,
      generated_from: "b43e8d4adb33d43798e610efe404afc79db14642",
      counties: [],
    });
    const fetcher = vi.fn(async () => {
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/vnd.ipld.raw" },
      });
    });

    try {
      const first = await syncAtlas({
        connections,
        databaseUrl,
        fetch: { fetcher },
        gateways: ["https://gateway.example"],
        ipns: "k51-test",
        stagingDirectory: path.join(directory, "staging"),
      });
      const stateAfterFirst = await connections.read(
        "SELECT index_cid, synced_at FROM atlas_sync_state",
      );
      const second = await syncAtlas({
        connections,
        databaseUrl,
        fetch: { fetcher },
        gateways: ["https://gateway.example"],
        ipns: "k51-test",
        stagingDirectory: path.join(directory, "staging"),
      });
      const stateAfterSecond = await connections.read(
        "SELECT index_cid, synced_at FROM atlas_sync_state",
      );

      expect(first).toMatchObject({
        groupsLoaded: 0,
        groupsWithdrawn: 0,
        unchanged: false,
      });
      expect(second).toMatchObject({
        groupsLoaded: 0,
        groupsWithdrawn: 0,
        unchanged: true,
      });
      expect(stateAfterSecond).toEqual(stateAfterFirst);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      await connections.close();
    }
  });

  it("keeps caller files in the staging directory and closes owned connections on failure", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-sync-"));
    directories.push(directory);
    const databaseUrl = `file://${path.join(directory, "atlas.sqlite")}`;
    const staging = path.join(directory, "staging");
    await rm(staging, { recursive: true, force: true });
    await writeFile(path.join(directory, "keep.txt"), "keep");
    const body = JSON.stringify({
      version: 1,
      generated_from: "b43e8d4adb33d43798e610efe404afc79db14642",
      counties: [],
    });
    const fetcher = vi.fn(async () => new Response(body, { status: 200 }));

    await syncAtlas({
      databaseUrl,
      fetch: { fetcher },
      gateways: ["https://gateway.example"],
      ipns: "k51-test",
      stagingDirectory: directory,
    });
    expect(await readFile(path.join(directory, "keep.txt"), "utf8")).toBe(
      "keep",
    );

    const holder = await openAtlasConnections(
      parseAtlasDatabaseUrl(databaseUrl),
    );
    const lock = await acquireAtlasSyncLock(
      parseAtlasDatabaseUrl(databaseUrl),
      holder.write,
    );
    try {
      opened.length = 0;
      await expect(
        syncAtlas({
          databaseUrl,
          fetch: { fetcher },
          gateways: ["https://gateway.example"],
          ipns: "k51-test",
          stagingDirectory: directory,
        }),
      ).rejects.toThrow("already running");
      expect(opened).toHaveLength(1);
      expect(opened[0].close).toHaveBeenCalledTimes(1);
    } finally {
      await lock.release();
      await holder.close();
    }
  });
});
