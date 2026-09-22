import type { AtlasBackend } from "./backend.ts";
import type { AtlasExecutor } from "./connections.ts";
import type { AtlasGroupTarget, AtlasGroupWithdrawal } from "./plan.ts";
import {
  atlasKeyColumns,
  describeAtlasTable,
  ensureAtlasTable,
  escapeAtlasLiteral,
  quoteAtlasIdentifier,
  readAtlasCatalog,
  type AtlasParquetColumn,
} from "./tables.ts";

export interface AtlasStagedTable {
  columns: AtlasParquetColumn[];
  name: string;
  rows: number;
  stageTable: string;
}

async function removeGroup(
  executor: AtlasExecutor,
  backend: AtlasBackend["kind"],
  county: string,
  dataGroup: string,
): Promise<void> {
  const catalog = await readAtlasCatalog(
    (statement) => executor.execute(statement).then((result) => result.rows),
    backend,
  );
  for (const table of [...catalog.keys(), "atlas_state"]) {
    await executor.execute(
      `DELETE FROM ${quoteAtlasIdentifier(table)}
       WHERE county = ? AND data_group = ?`,
      [county, dataGroup],
    );
  }
}

async function loadTable(
  executor: AtlasExecutor,
  backend: AtlasBackend["kind"],
  group: AtlasGroupTarget,
  staged: AtlasStagedTable,
): Promise<void> {
  const table = describeAtlasTable(staged.name, staged.columns);
  await ensureAtlasTable(executor, backend, table);
  const keys = atlasKeyColumns(table);
  const columns = table.columns.map((column) => column.name);
  const quoted = columns.map(quoteAtlasIdentifier).join(", ");
  const updates = columns
    .filter((column) => !keys.includes(column))
    .map(
      (column) =>
        `${quoteAtlasIdentifier(column)} = excluded.${quoteAtlasIdentifier(column)}`,
    );
  await executor.execute(
    `INSERT INTO ${quoteAtlasIdentifier(table.name)} ("county", "data_group", ${quoted})
     SELECT ${escapeAtlasLiteral(group.county)}, ${escapeAtlasLiteral(
       group.dataGroup,
     )}, ${quoted}
     FROM ${quoteAtlasIdentifier(staged.stageTable)}
     WHERE true
     ON CONFLICT (${keys.map(quoteAtlasIdentifier).join(", ")}) ${
       updates.length === 0
         ? "DO NOTHING"
         : `DO UPDATE SET ${updates.join(", ")}`
     }`,
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
    await removeGroup(
      args.executor,
      args.backend,
      withdrawal.county,
      withdrawal.dataGroup,
    );
  }

  const loadedAt = new Date().toISOString();
  for (const { group, tables } of args.groups) {
    await removeGroup(
      args.executor,
      args.backend,
      group.county,
      group.dataGroup,
    );
    for (const table of tables) {
      await loadTable(args.executor, args.backend, group, table);
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
