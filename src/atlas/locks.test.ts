import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseAtlasDatabaseUrl } from "./backend.ts";
import type { AtlasExecutor } from "./connections.ts";
import { acquireAtlasSyncLock } from "./locks.ts";

const directories: string[] = [];
const unusedExecutor: AtlasExecutor = {
  execute: () => {
    throw new Error("SQLite locking must not query the database");
  },
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Atlas synchronization lock", () => {
  it("allows one SQLite synchronizer at a time", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-lock-"));
    directories.push(directory);
    const backend = parseAtlasDatabaseUrl(
      `file://${path.join(directory, "atlas.sqlite")}`,
    );
    const first = await acquireAtlasSyncLock(backend, unusedExecutor);

    await expect(acquireAtlasSyncLock(backend, unusedExecutor)).rejects.toThrow(
      "already running",
    );

    await first.release();
    const second = await acquireAtlasSyncLock(backend, unusedExecutor);
    await second.release();
  });

  it("can release a SQLite lock repeatedly", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-lock-"));
    directories.push(directory);
    const backend = parseAtlasDatabaseUrl(
      `file://${path.join(directory, "atlas.sqlite")}`,
    );
    const lock = await acquireAtlasSyncLock(backend, unusedExecutor);

    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
