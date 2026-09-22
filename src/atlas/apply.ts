import type { AtlasBackend } from "./backend.ts";
import type { AtlasExecutor } from "./connections.ts";
import type { AtlasStateRow } from "./plan.ts";
import {
  atlasKeyColumns,
  describeAtlasTable,
  ensureAtlasTable,
  quoteAtlasIdentifier,
  readAtlasCatalog,
  type AtlasParquetColumn,
} from "./tables.ts";

export interface AtlasStagedTable {
  columns: AtlasParquetColumn[];
  name: string;
  rows: number;
  read(): AsyncIterable<Record<string, unknown>>;
}

/** Rows per INSERT, bounded by SQLite's default 32766 bind parameters. */
const PARAMETER_BUDGET = 32_000;

async function removeGroup(
  executor: AtlasExecutor,
  backend: AtlasBackend["kind"],
  state: string,
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
       WHERE state = ? AND county = ? AND data_group = ?`,
      [state, county, dataGroup],
    );
  }
}

async function loadTable(
  executor: AtlasExecutor,
  backend: AtlasBackend["kind"],
  group: AtlasStateRow,
  staged: AtlasStagedTable,
): Promise<void> {
  const table = describeAtlasTable(staged.name, staged.columns);
  await ensureAtlasTable(executor, backend, table);
  const keys = atlasKeyColumns(table);
  const columns = table.columns.map((column) => column.name);
  const quoted = ["state", "county", "data_group", ...columns].map(
    quoteAtlasIdentifier,
  );
  const updates = columns
    .filter((column) => !keys.includes(column))
    .map(
      (column) =>
        `${quoteAtlasIdentifier(column)} = excluded.${quoteAtlasIdentifier(column)}`,
    );
  const tuple = `(${quoted.map(() => "?").join(", ")})`;
  const batchSize = Math.max(1, Math.floor(PARAMETER_BUDGET / quoted.length));
  const insert = (batch: Array<Record<string, unknown>>) =>
    executor.execute(
      `INSERT INTO ${quoteAtlasIdentifier(table.name)} (${quoted.join(", ")})
       VALUES ${batch.map(() => tuple).join(", ")}
       ON CONFLICT (${keys.map(quoteAtlasIdentifier).join(", ")}) ${
         updates.length === 0
           ? "DO NOTHING"
           : `DO UPDATE SET ${updates.join(", ")}`
       }`,
      batch.flatMap((row) => [
        group.state,
        group.county,
        group.dataGroup,
        ...columns.map((column) => row[column] ?? null),
      ]),
    );

  let loaded = 0;
  let batch: Array<Record<string, unknown>> = [];
  for await (const row of staged.read()) {
    batch.push(row);
    if (batch.length === batchSize) {
      await insert(batch);
      loaded += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await insert(batch);
    loaded += batch.length;
  }
  if (loaded !== staged.rows) {
    throw new Error(
      `Atlas table ${staged.name} loaded ${loaded} rows, expected ${staged.rows}`,
    );
  }
}

export async function applyAtlasIndexTransaction(args: {
  backend: AtlasBackend["kind"];
  executor: AtlasExecutor;
  generatedFrom: string;
  groups: Array<{
    group: AtlasStateRow;
    tables: AtlasStagedTable[];
  }>;
  indexCid: string;
  withdrawals: Array<Pick<AtlasStateRow, "state" | "county" | "dataGroup">>;
}): Promise<void> {
  for (const withdrawal of args.withdrawals) {
    await removeGroup(
      args.executor,
      args.backend,
      withdrawal.state,
      withdrawal.county,
      withdrawal.dataGroup,
    );
  }

  const loadedAt = new Date().toISOString();
  for (const { group, tables } of args.groups) {
    await removeGroup(
      args.executor,
      args.backend,
      group.state,
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
