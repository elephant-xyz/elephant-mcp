import type { AtlasBackend } from "./backend.ts";
import type { AtlasExecutor } from "./connections.ts";
import { quoteAtlasIdentifier } from "./registry.ts";

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
  `CREATE TABLE IF NOT EXISTS atlas_table_registry (
    table_name TEXT PRIMARY KEY,
    physical_table_name TEXT NOT NULL UNIQUE,
    table_kind TEXT NOT NULL CHECK (
      table_kind IN ('entity', 'relationship')
    ),
    primary_key_column TEXT NOT NULL CHECK (
      primary_key_column IN ('cid', 'relationship_cid')
    ),
    created_index_cid TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS atlas_column_registry (
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    canonical_type TEXT NOT NULL CHECK (
      canonical_type IN ('text', 'boolean', 'int64', 'double')
    ),
    first_index_cid TEXT NOT NULL,
    PRIMARY KEY (table_name, column_name)
  )`,
  `CREATE TABLE IF NOT EXISTS atlas_membership (
    table_name TEXT NOT NULL,
    row_cid TEXT NOT NULL,
    county TEXT NOT NULL,
    data_group TEXT NOT NULL,
    property_cid TEXT NOT NULL,
    parquet_data_group_cid TEXT NOT NULL,
    archive_cid TEXT NOT NULL,
    tables_cid TEXT NOT NULL,
    PRIMARY KEY (
      table_name,
      row_cid,
      county,
      data_group,
      property_cid,
      archive_cid,
      tables_cid
    )
  )`,
  `CREATE TABLE IF NOT EXISTS atlas_property_roots (
    county TEXT NOT NULL,
    data_group TEXT NOT NULL,
    property_cid TEXT NOT NULL,
    root_schema_cid TEXT NOT NULL,
    root_cid TEXT NOT NULL,
    archive_cid TEXT NOT NULL,
    tables_cid TEXT NOT NULL,
    PRIMARY KEY (
      county,
      data_group,
      property_cid,
      root_schema_cid
    )
  )`,
  `CREATE TABLE IF NOT EXISTS atlas_sync_runs (
    run_id TEXT PRIMARY KEY,
    candidate_index_cid TEXT NOT NULL,
    generated_from TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('staging', 'committed', 'failed', 'abandoned')
    ),
    started_at TEXT NOT NULL,
    staged_at TEXT,
    committed_at TEXT,
    error_code TEXT,
    sanitized_error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS atlas_state_county_idx
    ON atlas_state (state, county)`,
  `CREATE INDEX IF NOT EXISTS atlas_membership_scope_idx
    ON atlas_membership (county, data_group, table_name, property_cid)`,
  `CREATE INDEX IF NOT EXISTS atlas_membership_row_idx
    ON atlas_membership (table_name, row_cid)`,
  `CREATE INDEX IF NOT EXISTS atlas_property_roots_scope_idx
    ON atlas_property_roots (county, data_group, property_cid)`,
] as const;

export async function initializeAtlasSchema(
  executor: AtlasExecutor,
): Promise<void> {
  for (const statement of CONTROL_SCHEMA) {
    await executor.execute(statement);
  }
}

export async function cleanupAtlasStages(
  executor: AtlasExecutor,
  backend: AtlasBackend["kind"],
): Promise<number> {
  const result = await executor.execute(
    backend === "sqlite"
      ? `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'atlas_stage__%'`
      : `SELECT table_name AS name
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name LIKE 'atlas_stage__%'`,
  );
  for (const row of result.rows) {
    await executor.execute(
      `DROP TABLE IF EXISTS ${quoteAtlasIdentifier(String(row.name))}`,
    );
  }
  return result.rows.length;
}
