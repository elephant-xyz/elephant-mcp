import type { AtlasBackend } from "./backend.ts";
import type { AtlasExecutor } from "./connections.ts";
import type { AtlasGroupTarget, AtlasGroupWithdrawal } from "./plan.ts";
import {
  describeAtlasContentTable,
  ensureAtlasContentTable,
  escapeAtlasLiteral,
  quoteAtlasIdentifier,
  type AtlasParquetColumn,
} from "./registry.ts";

export interface AtlasStagedTable {
  columns: AtlasParquetColumn[];
  logicalName: string;
  rows: number;
  stageTable: string;
}

function value(value: string): string {
  return escapeAtlasLiteral(value);
}

async function removeGroup(
  executor: AtlasExecutor,
  county: string,
  dataGroup: string,
): Promise<void> {
  for (const table of [
    "atlas_membership",
    "atlas_property_roots",
    "atlas_state",
  ]) {
    await executor.execute(
      `DELETE FROM ${table} WHERE county = ? AND data_group = ?`,
      [county, dataGroup],
    );
  }
}

async function applyContentTable(
  executor: AtlasExecutor,
  backend: AtlasBackend["kind"],
  indexCid: string,
  group: AtlasGroupTarget,
  staged: AtlasStagedTable,
): Promise<void> {
  const content = describeAtlasContentTable(staged.logicalName, staged.columns);
  if (content === null) {
    for (const column of staged.columns) {
      if (column.name === "property_cid") continue;
      await executor.execute(
        `INSERT INTO atlas_property_roots (
          county,
          data_group,
          property_cid,
          root_schema_cid,
          root_cid,
          archive_cid,
          tables_cid
        )
        SELECT ?, ?, property_cid, ?, ${quoteAtlasIdentifier(column.name)}, ?, ?
        FROM ${quoteAtlasIdentifier(staged.stageTable)}
        WHERE ${quoteAtlasIdentifier(column.name)} IS NOT NULL
        ON CONFLICT (
          county,
          data_group,
          property_cid,
          root_schema_cid
        ) DO UPDATE SET
          root_cid = excluded.root_cid,
          archive_cid = excluded.archive_cid,
          tables_cid = excluded.tables_cid`,
        [
          group.county,
          group.dataGroup,
          column.name,
          group.archiveCid,
          group.tablesCid,
        ],
      );
    }
    return;
  }

  await ensureAtlasContentTable(executor, backend, content, indexCid);
  const contentColumns = content.columns.map((column) =>
    quoteAtlasIdentifier(column.name),
  );
  const updates = contentColumns
    .filter((column) => column !== quoteAtlasIdentifier(content.primaryKey))
    .map((column) => `${column} = excluded.${column}`);
  await executor.execute(
    `INSERT INTO ${quoteAtlasIdentifier(content.physicalName)} (${contentColumns.join(", ")})
     SELECT DISTINCT ${contentColumns.join(", ")}
     FROM ${quoteAtlasIdentifier(staged.stageTable)}
     WHERE true
     ON CONFLICT (${quoteAtlasIdentifier(content.primaryKey)}) ${
       updates.length === 0
         ? "DO NOTHING"
         : `DO UPDATE SET ${updates.join(", ")}`
     }`,
  );

  const membershipConflict = [
    "table_name",
    "row_cid",
    "county",
    "data_group",
    "property_cid",
    "archive_cid",
    "tables_cid",
  ].join(", ");
  await executor.execute(
    `INSERT INTO atlas_membership (
      table_name,
      row_cid,
      county,
      data_group,
      property_cid,
      parquet_data_group_cid,
      archive_cid,
      tables_cid
    )
    SELECT
      ${value(content.logicalName)},
      ${quoteAtlasIdentifier(content.primaryKey)},
      ${value(group.county)},
      ${value(group.dataGroup)},
      property_cid,
      data_group_cid,
      ${value(group.archiveCid)},
      ${value(group.tablesCid)}
    FROM ${quoteAtlasIdentifier(staged.stageTable)}
    WHERE true
    ON CONFLICT (${membershipConflict}) DO NOTHING`,
  );
}

export async function applyAtlasIndexTransaction(args: {
  backend: AtlasBackend["kind"];
  executor: AtlasExecutor;
  generatedFrom: string;
  groups: Array<{
    group: AtlasGroupTarget;
    tables: AtlasStagedTable[];
  }>;
  indexCid: string;
  withdrawals: AtlasGroupWithdrawal[];
}): Promise<void> {
  for (const withdrawal of args.withdrawals) {
    await removeGroup(args.executor, withdrawal.county, withdrawal.dataGroup);
  }

  const loadedAt = new Date().toISOString();
  for (const { group, tables } of args.groups) {
    await removeGroup(args.executor, group.county, group.dataGroup);
    for (const table of tables) {
      await applyContentTable(
        args.executor,
        args.backend,
        args.indexCid,
        group,
        table,
      );
    }
    await args.executor.execute(
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        group.county,
        group.state,
        group.fips,
        group.dataGroup,
        group.archiveCid,
        group.tablesCid,
        group.schemaCid,
        group.publishedAt,
        loadedAt,
      ],
    );
  }

  const registry = await args.executor.execute(
    "SELECT physical_table_name, table_name FROM atlas_table_registry",
  );
  for (const row of registry.rows) {
    const physical = String(row.physical_table_name);
    const logical = String(row.table_name);
    await args.executor.execute(
      `DELETE FROM ${quoteAtlasIdentifier(physical)}
       WHERE NOT EXISTS (
         SELECT 1
         FROM atlas_membership
         WHERE atlas_membership.table_name = ?
           AND atlas_membership.row_cid =
             ${quoteAtlasIdentifier(physical)}.${quoteAtlasIdentifier(
               await primaryKeyFor(args.executor, logical),
             )}
       )`,
      [logical],
    );
  }

  await args.executor.execute(
    "DELETE FROM atlas_sync_state WHERE singleton_key = 1",
  );
  await args.executor.execute(
    `INSERT INTO atlas_sync_state (
      singleton_key,
      index_cid,
      generated_from,
      synced_at
    ) VALUES (1, ?, ?, ?)`,
    [args.indexCid, args.generatedFrom, loadedAt],
  );
}

async function primaryKeyFor(
  executor: AtlasExecutor,
  logicalName: string,
): Promise<string> {
  const result = await executor.execute(
    `SELECT primary_key_column
     FROM atlas_table_registry
     WHERE table_name = ?`,
    [logicalName],
  );
  const primaryKey = result.rows[0]?.primary_key_column;
  if (primaryKey !== "cid" && primaryKey !== "relationship_cid") {
    throw new Error(`Atlas table ${logicalName} has no registered primary key`);
  }
  return primaryKey;
}
