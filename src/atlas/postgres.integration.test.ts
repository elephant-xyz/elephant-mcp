import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  applyAtlasGroupTransaction,
  finalizeAtlasIndexTransaction,
} from "./apply.ts";
import { parseAtlasDatabaseUrl } from "./backend.ts";
import { openAtlasConnections } from "./connections.ts";
import { normalizedRows } from "./query.ts";
import { ATLAS_SYNC_LOCK_ID } from "./sync.ts";
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
      const tryLock = (executor: { execute: typeof first.write.execute }) =>
        executor
          .execute("SELECT pg_try_advisory_xact_lock(?) AS acquired", [
            ATLAS_SYNC_LOCK_ID,
          ])
          .then((result) => result.rows[0]?.acquired);
      await first.transaction(async (executor) => {
        expect(await tryLock(executor)).toBe(true);
        await expect(second.transaction(tryLock)).resolves.toBe(false);
      });
      await expect(second.transaction(tryLock)).resolves.toBe(true);

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

      // Verify COPY FROM STDIN bulk load + deduplication + withdrawal cleanup.
      const copyCounty = `copy-${randomUUID().slice(0, 8)}`;
      const tableName = `copy_test_${randomUUID().slice(0, 8).replace(/-/gu, "")}`;
      try {
        await first.transaction(async (executor) => {
          await applyAtlasGroupTransaction({
            backend: "postgres",
            executor,
            group: {
              county: copyCounty,
              state: "FL",
              fips: "12000",
              dataGroup: "county",
              archiveCid: "copy-archive",
              tablesCid: "copy-tables",
              schemaCid: "copy-schema",
              publishedAt: new Date().toISOString(),
            },
            tables: [
              {
                name: tableName,
                columns: [
                  { name: "cid", canonicalType: "text" },
                  { name: "property_cid", canonicalType: "text" },
                  { name: "data_group_cid", canonicalType: "text" },
                  { name: "label", canonicalType: "text" },
                  { name: "active", canonicalType: "boolean" },
                  { name: "score", canonicalType: "int64" },
                ],
                rows: 3,
                async *read() {
                  yield {
                    cid: "c1",
                    property_cid: "p1",
                    data_group_cid: "dg1",
                    label: "Acme\tCo\nLine\\2",
                    active: true,
                    score: 10n,
                  };
                  yield {
                    cid: "c1",
                    property_cid: "p1",
                    data_group_cid: "dg1",
                    label: "Acme\tCo\nLine\\2",
                    active: true,
                    score: 10n,
                  };
                  yield {
                    cid: "c2",
                    property_cid: "p2",
                    data_group_cid: "dg1",
                    label: null,
                    active: false,
                    score: 20n,
                  };
                },
              },
            ],
          });
        });

        const loaded = await first.read(
          `SELECT cid, label, active, score FROM "${tableName}" WHERE county = '${copyCounty}' ORDER BY cid`,
        );
        expect(normalizedRows(loaded)).toEqual([
          { cid: "c1", label: "Acme\tCo\nLine\\2", active: true, score: 10 },
          { cid: "c2", label: null, active: false, score: 20 },
        ]);

        await first.transaction(async (executor) => {
          await finalizeAtlasIndexTransaction({
            backend: "postgres",
            executor,
            generatedFrom: "test-commit",
            indexCid: "test-index-cid",
            withdrawals: [
              { state: "FL", county: copyCounty, dataGroup: "county" },
            ],
          });
        });
        expect(
          await first.read(
            `SELECT cid FROM "${tableName}" WHERE county = '${copyCounty}'`,
          ),
        ).toEqual([]);
      } finally {
        await first.write.execute(`DROP TABLE IF EXISTS "${tableName}"`);
        await first.write.execute(
          "DELETE FROM atlas_sync_state WHERE index_cid = 'test-index-cid'",
        );
      }
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  }, 30_000);
});
