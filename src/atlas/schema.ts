import type { AtlasExecutor } from "./connections.ts";

/**
 * Control tables. Content tables are created per CountyTables table by
 * `ensureAtlasTable` and discovered through the database catalog.
 */
const CONTROL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS atlas_sync_state (
    singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
    index_cid TEXT NOT NULL,
    generated_from TEXT NOT NULL,
    synced_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS atlas_state (
    county TEXT NOT NULL,
    state TEXT NOT NULL,
    fips TEXT NOT NULL,
    data_group TEXT NOT NULL,
    archive_cid TEXT NOT NULL,
    tables_cid TEXT NOT NULL,
    schema_cid TEXT NOT NULL,
    published_at TEXT NOT NULL,
    loaded_at TEXT NOT NULL,
    PRIMARY KEY (county, data_group)
  )`,
  `CREATE INDEX IF NOT EXISTS atlas_state_county_idx
    ON atlas_state (state, county)`,
] as const;

export async function initializeAtlasSchema(
  executor: AtlasExecutor,
): Promise<void> {
  for (const statement of CONTROL_SCHEMA) {
    await executor.execute(statement);
  }
}
