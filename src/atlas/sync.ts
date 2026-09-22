import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { getConfig } from "../config.ts";
import { getDefaultDataDir } from "../lib/paths.ts";
import { logger } from "../logger.ts";
import { applyAtlasIndexTransaction, type AtlasStagedTable } from "./apply.ts";
import { parseAtlasDatabaseUrl } from "./backend.ts";
import {
  downloadAtlasPart,
  fetchCountyIndex,
  fetchCountyTables,
  resolveAtlasIndex,
} from "./client.ts";
import {
  openAtlasConnections,
  type AtlasConnections,
  type AtlasExecutor,
} from "./connections.ts";
import {
  openAtlasDuckDb,
  readAtlasParquet,
  type AtlasDuckDb,
} from "./duckdbEtl.ts";
import type { AtlasGatewayFetchOptions } from "./gateways.ts";
import {
  planAtlasSync,
  type AtlasStateRow,
  type AtlasSyncStateRow,
} from "./plan.ts";
import { inspectAtlasParquet } from "./tables.ts";
import { initializeAtlasSchema } from "./schema.ts";

/** Postgres advisory lock key; SQLite uses the write transaction itself. */
export const ATLAS_SYNC_LOCK_ID = 1_163_151_188;

export interface AtlasGroupSyncSummary {
  bytes: number;
  county: string;
  dataGroup: string;
  parts: number;
  rows: number;
  tables: number;
}

export interface AtlasSyncSummary {
  groupsLoaded: number;
  groupsSkipped: number;
  groupsWithdrawn: number;
  indexCid: string;
  unchanged: boolean;
  loaded: AtlasGroupSyncSummary[];
}

export interface AtlasSyncOptions {
  connections?: AtlasConnections;
  databaseUrl?: string;
  fetch?: AtlasGatewayFetchOptions;
  gateways?: readonly string[];
  ipns?: string;
  stagingDirectory?: string;
}

interface StagedGroup {
  group: AtlasStateRow;
  summary: AtlasGroupSyncSummary;
  tables: AtlasStagedTable[];
}

function toStateRow(row: Record<string, unknown>): AtlasStateRow {
  return {
    county: String(row.county),
    state: String(row.state),
    fips: String(row.fips),
    dataGroup: String(row.data_group),
    archiveCid: String(row.archive_cid),
    tablesCid: String(row.tables_cid),
    schemaCid: String(row.schema_cid),
    publishedAt: String(row.published_at),
  };
}

async function readCurrentState(executor: AtlasExecutor): Promise<{
  state: AtlasStateRow[];
  syncState: AtlasSyncStateRow | null;
}> {
  const syncRows = (
    await executor.execute(
      `SELECT index_cid, generated_from
       FROM atlas_sync_state
       WHERE singleton_key = 1`,
    )
  ).rows;
  const stateRows = (
    await executor.execute(
      `SELECT
        county,
        state,
        fips,
        data_group,
        archive_cid,
        tables_cid,
        schema_cid,
        published_at
       FROM atlas_state`,
    )
  ).rows;
  const sync = syncRows[0];
  return {
    syncState:
      sync === undefined
        ? null
        : {
            indexCid: String(sync.index_cid),
            generatedFrom: String(sync.generated_from),
          },
    state: stateRows.map(toStateRow),
  };
}

async function stageGroup(args: {
  duckdb: AtlasDuckDb;
  fetchOptions: AtlasGatewayFetchOptions;
  group: AtlasStateRow;
  runDirectory: string;
}): Promise<StagedGroup> {
  await fetchCountyIndex(args.group.archiveCid, args.fetchOptions);
  const tablesBlock = await fetchCountyTables(
    args.group.tablesCid,
    args.group.archiveCid,
    args.fetchOptions,
  );
  const stagedTables: AtlasStagedTable[] = [];
  let bytes = 0;
  let parts = 0;
  let rows = 0;

  for (const [name, table] of Object.entries(tablesBlock.tables)) {
    const files: string[] = [];
    for (const part of table.parts) {
      const downloaded = await downloadAtlasPart(
        part.cid,
        part.bytes,
        path.join(
          args.runDirectory,
          args.group.county,
          args.group.dataGroup,
          name,
        ),
        args.fetchOptions,
      );
      files.push(downloaded.filePath);
      bytes += downloaded.bytes;
      parts += 1;
    }
    const columns = await inspectAtlasParquet(args.duckdb.connection, files);
    rows += table.rows;
    stagedTables.push({
      columns,
      name,
      rows: table.rows,
      read: () => readAtlasParquet(args.duckdb.connection, files, columns),
    });
  }

  return {
    group: args.group,
    summary: {
      bytes,
      county: args.group.county,
      dataGroup: args.group.dataGroup,
      parts,
      rows,
      tables: stagedTables.length,
    },
    tables: stagedTables,
  };
}

export async function syncAtlas(
  options: AtlasSyncOptions = {},
): Promise<AtlasSyncSummary> {
  const config = getConfig();
  const backend = parseAtlasDatabaseUrl(
    options.databaseUrl ?? config.DATABASE_URL,
  );
  const connections =
    options.connections ?? (await openAtlasConnections(backend));
  const ownsConnections = options.connections === undefined;
  // Only ever delete a directory this run created itself.
  const runDirectory = path.join(
    options.stagingDirectory ??
      path.join(getDefaultDataDir(), "atlas", "staging"),
    randomUUID(),
  );
  const fetchOptions: AtlasGatewayFetchOptions = {
    ...options.fetch,
    gateways:
      options.gateways ??
      config.ATLAS_GATEWAYS.split(",")
        .map((gateway) => gateway.trim())
        .filter(Boolean),
  };
  let duckdb: AtlasDuckDb | undefined;

  try {
    await initializeAtlasSchema(connections.write);
    // The write transaction is the sync lock: BEGIN IMMEDIATE on SQLite, a
    // transaction-scoped advisory lock on Postgres. A concurrent sync fails
    // fast (SQLITE_BUSY after busy_timeout, or "already running"), while
    // readers keep serving the accepted snapshot under WAL.
    return await connections.transaction(async (executor) => {
      if (backend.kind === "postgres") {
        const locked = await executor.execute(
          "SELECT pg_try_advisory_xact_lock(?) AS acquired",
          [ATLAS_SYNC_LOCK_ID],
        );
        if (locked.rows[0]?.acquired !== true) {
          throw new Error("Atlas synchronization is already running");
        }
      }
      const resolved = await resolveAtlasIndex(
        options.ipns ?? config.ATLAS_IPNS,
        fetchOptions,
      );
      const current = await readCurrentState(executor);
      const plan = planAtlasSync(
        resolved.index,
        resolved.indexCid,
        current.syncState,
        current.state,
      );
      if (plan.unchanged) {
        logger.info(
          { indexCid: resolved.indexCid },
          "Atlas index already synchronized",
        );
      }

      const staged: StagedGroup[] = [];
      if (plan.load.length > 0) {
        await mkdir(runDirectory, { recursive: true });
        duckdb = await openAtlasDuckDb();
        for (const group of plan.load) {
          const stagedGroup = await stageGroup({
            duckdb,
            fetchOptions,
            group,
            runDirectory,
          });
          staged.push(stagedGroup);
          logger.info(stagedGroup.summary, "Staged Atlas county group");
        }
      }

      // An unchanged index performs no database writes.
      if (!plan.unchanged) {
        await applyAtlasIndexTransaction({
          backend: backend.kind,
          executor,
          generatedFrom: plan.generatedFrom,
          groups: staged,
          indexCid: plan.indexCid,
          withdrawals: plan.withdraw,
        });
      }

      const summary: AtlasSyncSummary = {
        groupsLoaded: staged.length,
        groupsSkipped: plan.skipped,
        groupsWithdrawn: plan.withdraw.length,
        indexCid: plan.indexCid,
        unchanged: plan.unchanged,
        loaded: staged.map((group) => group.summary),
      };
      logger.info(summary, "Atlas synchronization completed");
      return summary;
    });
  } finally {
    duckdb?.close();
    await rm(runDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    if (ownsConnections) {
      await connections.close();
    }
  }
}
