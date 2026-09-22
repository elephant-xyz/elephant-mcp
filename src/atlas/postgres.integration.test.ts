import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { parseAtlasDatabaseUrl } from "./backend.ts";
import { openAtlasConnections } from "./connections.ts";
import { acquireAtlasSyncLock } from "./locks.ts";
import { normalizedRows } from "./query.ts";
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

      const county = `rollback-${randomUUID()}`;
      await expect(
        first.transaction(async (executor) => {
          await executor.execute(
            `INSERT INTO atlas_state (
                  county,
                  state,
                  fips,
                  data_group,
                  archive_cid,
                  tables_cid,
                  schema_cid,
                  published_at,
                  loaded_at
                ) VALUES (?, 'FL', '00000', 'county', 'a', 't', 's', ?, ?)`,
            [county, new Date().toISOString(), new Date().toISOString()],
          );
          throw new Error("rollback-test");
        }),
      ).rejects.toThrow("rollback-test");
      expect(
        await first.read(
          `SELECT county FROM atlas_state WHERE county = '${county}'`,
        ),
      ).toEqual([]);
      const [counted] = await first.read(
        "SELECT count(*) AS count, 9007199254740993::bigint AS big FROM atlas_state",
      );
      expect(typeof counted?.count).toBe("bigint");
      expect(normalizedRows([counted ?? {}])[0]).toMatchObject({
        big: "9007199254740993",
      });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  }, 30_000);
});
