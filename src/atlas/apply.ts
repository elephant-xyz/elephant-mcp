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
/** Target UTF-8 buffer size per COPY FROM STDIN write chunk. */
const COPY_CHUNK_BYTES = 256 * 1024;

/**
 * Encode one column value for Postgres `COPY ... FROM STDIN WITH (FORMAT text)`.
 * Strips NUL bytes (disallowed in Postgres TEXT) and escapes backslash, tab, CR, LF.
 */
export function formatPostgresCopyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "\\N";
  }
  if (typeof value === "boolean") {
    return value ? "t" : "f";
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return String(value)
    .replace(/\0/gu, "")
    .replace(/\\/gu, "\\\\")
    .replace(/\t/gu, "\\t")
    .replace(/\r/gu, "\\r")
    .replace(/\n/gu, "\\n");
}

async function removeGroup(
  executor: AtlasExecutor,
  backend: AtlasBackend["kind"],
  state: string,
  county: string,
  dataGroup: string,
): Promise<void> {
  // atlas_state is updated atomically with content tables, so a scope absent
  // from atlas_state has no content rows to delete.
  const present = await executor.execute(
    `SELECT 1 AS present
     FROM atlas_state
     WHERE state = ? AND county = ? AND data_group = ?
     LIMIT 1`,
    [state, county, dataGroup],
  );
  if (present.rows.length === 0) {
    return;
  }
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

async function loadTableWithPostgresCopy(
  executor: AtlasExecutor,
  group: AtlasStateRow,
  staged: AtlasStagedTable,
  tableName: string,
  columns: readonly string[],
  quoted: readonly string[],
): Promise<void> {
  if (executor.copyFrom === undefined) {
    throw new Error("Postgres executor does not support COPY FROM STDIN");
  }
  // removeGroup has already deleted every row for (state, county, data_group)
  // in this transaction, and export-tables writes unique keys per archive.
  // Streaming COPY directly into the target table avoids pg_temp sort spills
  // (base/pgsql_tmp disk quota) on multi-million-row counties like LA.
  const quotedTable = quoteAtlasIdentifier(tableName);
  const columnList = quoted.join(", ");
  const scopePrefix = [
    formatPostgresCopyValue(group.state),
    formatPostgresCopyValue(group.county),
    formatPostgresCopyValue(group.dataGroup),
  ].join("\t");

  let loaded = 0;
  async function* copyChunks(): AsyncIterable<Buffer> {
    let buffer = "";
    for await (const row of staged.read()) {
      const encoded = columns.map((column) =>
        formatPostgresCopyValue(row[column]),
      );
      buffer += `${scopePrefix}\t${encoded.join("\t")}\n`;
      loaded += 1;
      if (buffer.length >= COPY_CHUNK_BYTES) {
        yield Buffer.from(buffer, "utf8");
        buffer = "";
      }
    }
    if (buffer.length > 0) {
      yield Buffer.from(buffer, "utf8");
    }
  }

  await executor.copyFrom(
    `COPY ${quotedTable} (${columnList}) FROM STDIN WITH (FORMAT text)`,
    copyChunks(),
  );

  if (loaded !== staged.rows) {
    throw new Error(
      `Atlas table ${staged.name} loaded ${loaded} rows, expected ${staged.rows}`,
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

  if (backend === "postgres" && executor.copyFrom !== undefined) {
    await loadTableWithPostgresCopy(
      executor,
      group,
      staged,
      table.name,
      columns,
      quoted,
    );
    return;
  }

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

export async function applyAtlasGroupTransaction(args: {
  backend: AtlasBackend["kind"];
  executor: AtlasExecutor;
  group: AtlasStateRow;
  tables: AtlasStagedTable[];
}): Promise<void> {
  const loadedAt = new Date().toISOString();
  await removeGroup(
    args.executor,
    args.backend,
    args.group.state,
    args.group.county,
    args.group.dataGroup,
  );
  for (const table of args.tables) {
    await loadTable(args.executor, args.backend, args.group, table);
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
      args.group.county,
      args.group.state,
      args.group.fips,
      args.group.dataGroup,
      args.group.archiveCid,
      args.group.tablesCid,
      args.group.schemaCid,
      args.group.publishedAt,
      loadedAt,
    ],
  );
}

/**
 * Seed a provisional `atlas_sync_state` row during an initial multi-group
 * Postgres backfill so already-committed counties are queryable immediately,
 * without marking `index_cid` as complete before every group finishes.
 */
export async function ensureProvisionalAtlasSyncState(args: {
  executor: AtlasExecutor;
  generatedFrom: string;
  indexCid: string;
}): Promise<void> {
  await args.executor.execute(
    `INSERT INTO atlas_sync_state (
      singleton_key,
      index_cid,
      generated_from,
      synced_at
    ) VALUES (1, ?, ?, ?)
    ON CONFLICT (singleton_key) DO NOTHING`,
    [`syncing:${args.indexCid}`, args.generatedFrom, new Date().toISOString()],
  );
}

export async function finalizeAtlasIndexTransaction(args: {
  backend: AtlasBackend["kind"];
  executor: AtlasExecutor;
  generatedFrom: string;
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

  const syncedAt = new Date().toISOString();
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
    [args.indexCid, args.generatedFrom, syncedAt],
  );
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

  for (const { group, tables } of args.groups) {
    await applyAtlasGroupTransaction({
      backend: args.backend,
      executor: args.executor,
      group,
      tables,
    });
  }

  await finalizeAtlasIndexTransaction({
    backend: args.backend,
    executor: args.executor,
    generatedFrom: args.generatedFrom,
    indexCid: args.indexCid,
    withdrawals: [],
  });
}
