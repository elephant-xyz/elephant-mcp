import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { parseAtlasDatabaseUrl } from "./backend.ts";
import { openAtlasConnections } from "./connections.ts";
import { acquireAtlasSyncLock } from "./locks.ts";
import { initializeAtlasSchema } from "./schema.ts";

const databaseUrl = process.env.ATLAS_POSTGRES_TEST_URL;

describe.runIf(databaseUrl !== undefined)("Atlas Postgres integration", () => {
  it("initializes metadata, enforces advisory locking, and rolls back writes", async () => {
    const backend = parseAtlasDatabaseUrl(databaseUrl);
    if (backend.kind !== "postgres") {
      throw new Error(
        "ATLAS_POSTGRES_TEST_URL must use postgres:// or postgresql://",
      );
    }
    const first = await openAtlasConnections(backend);
    const second = await openAtlasConnections(backend);
    try {
      await initializeAtlasSchema(first.write);
      const lock = await acquireAtlasSyncLock(backend, first.write);
      await expect(acquireAtlasSyncLock(backend, second.write)).rejects.toThrow(
        "already running",
      );
      await lock.release();

      const runId = randomUUID();
      await expect(
        first.transaction(async (executor) => {
          await executor.execute(
            `INSERT INTO atlas_sync_runs (
                  run_id,
                  candidate_index_cid,
                  generated_from,
                  status,
                  started_at
                ) VALUES (?, ?, ?, ?, ?)`,
            [
              runId,
              "test-index",
              "test-revision",
              "staging",
              new Date().toISOString(),
            ],
          );
          throw new Error("rollback-test");
        }),
      ).rejects.toThrow("rollback-test");
      expect(
        await first.read(
          `SELECT run_id
               FROM atlas_sync_runs
               WHERE run_id = '${runId}'`,
        ),
      ).toEqual([]);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  }, 30_000);
});
