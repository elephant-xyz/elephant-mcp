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
import { openAtlasConnections, type AtlasConnections } from "./connections.ts";
import {
  attachAtlasTarget,
  detachAtlasTarget,
  openAtlasDuckDb,
  stageAtlasParquet,
  type AtlasDuckDb,
} from "./duckdbEtl.ts";
import type { AtlasGatewayFetchOptions } from "./gateways.ts";
import { acquireAtlasSyncLock } from "./locks.ts";
import {
  planAtlasSync,
  type AtlasGroupTarget,
  type AtlasStateRow,
  type AtlasSyncStateRow,
} from "./plan.ts";
import { inspectAtlasParquet } from "./tables.ts";
import { cleanupAtlasStages, initializeAtlasSchema } from "./schema.ts";

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
  group: AtlasGroupTarget;
  summary: AtlasGroupSyncSummary;
  tables: AtlasStagedTable[];
}

function configuredGateways(value: string): string[] {
  const gateways = value
    .split(",")
    .map((gateway) => gateway.trim())
    .filter(Boolean);
  if (gateways.length === 0) {
    throw new Error("ATLAS_GATEWAYS must contain at least one gateway");
  }
  return gateways;
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

async function readCurrentState(connections: AtlasConnections): Promise<{
  state: AtlasStateRow[];
  syncState: AtlasSyncStateRow | null;
}> {
  const [syncRows, stateRows] = await Promise.all([
    connections.read(
      `SELECT index_cid, generated_from
       FROM atlas_sync_state
       WHERE singleton_key = 1`,
    ),
    connections.read(
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
    ),
  ]);
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
  group: AtlasGroupTarget;
  runDirectory: string;
  runToken: string;
  targetSchema: "main" | "public";
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
  let tableIndex = 0;

  for (const [name, table] of Object.entries(tablesBlock.value.tables)) {
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
    const stageTable = `atlas_stage__${args.runToken}__${tableIndex++}`;
    const loadedRows = await stageAtlasParquet({
      connection: args.duckdb.connection,
      files,
      stageTable,
      targetSchema: args.targetSchema,
    });
    if (loadedRows !== table.rows) {
      throw new Error(
        `Atlas table ${name} loaded ${loadedRows} rows, expected ${table.rows}`,
      );
    }
    rows += loadedRows;
    stagedTables.push({
      columns,
      name,
      rows: loadedRows,
      stageTable,
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
  await initializeAtlasSchema(connections.write);
  const lock = await acquireAtlasSyncLock(backend, connections.write);
  const runId = randomUUID();
  const runToken = runId.replaceAll("-", "");
  const runDirectory =
    options.stagingDirectory ??
    path.join(getDefaultDataDir(), "atlas", "staging", runId);
  const gateways =
    options.gateways ?? configuredGateways(config.ATLAS_GATEWAYS);
  const fetchOptions: AtlasGatewayFetchOptions = {
    ...options.fetch,
    gateways,
  };
  let duckdb: AtlasDuckDb | undefined;
  let targetAttached = false;
  let targetSchema: "main" | "public" = "main";
  const stageTables: string[] = [];

  try {
    await cleanupAtlasStages(connections.write, backend.kind);
    const resolved = await resolveAtlasIndex(
      options.ipns ?? config.ATLAS_IPNS,
      fetchOptions,
    );
    const current = await readCurrentState(connections);
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
      return {
        groupsLoaded: 0,
        groupsSkipped: 0,
        groupsWithdrawn: 0,
        indexCid: resolved.indexCid,
        unchanged: true,
        loaded: [],
      };
    }

    const loadGroups = plan.groups.filter((group) => group.action === "load");
    const staged: StagedGroup[] = [];
    if (loadGroups.length > 0) {
      await mkdir(runDirectory, { recursive: true });
      duckdb = await openAtlasDuckDb();
      targetSchema = await attachAtlasTarget(duckdb.connection, backend);
      targetAttached = true;
      for (const group of loadGroups) {
        const stagedGroup = await stageGroup({
          duckdb,
          fetchOptions,
          group,
          runDirectory,
          runToken,
          targetSchema,
        });
        staged.push(stagedGroup);
        stageTables.push(
          ...stagedGroup.tables.map((table) => table.stageTable),
        );
        logger.info(stagedGroup.summary, "Staged Atlas county group");
      }
      await detachAtlasTarget(duckdb.connection);
      targetAttached = false;
    }

    await connections.transaction((executor) =>
      applyAtlasIndexTransaction({
        backend: backend.kind,
        executor,
        generatedFrom: plan.generatedFrom,
        groups: staged,
        indexCid: plan.indexCid,
        withdrawals: plan.withdrawals,
      }),
    );

    const summary: AtlasSyncSummary = {
      groupsLoaded: staged.length,
      groupsSkipped: plan.groups.length - loadGroups.length,
      groupsWithdrawn: plan.withdrawals.length,
      indexCid: plan.indexCid,
      unchanged: false,
      loaded: staged.map((group) => group.summary),
    };
    logger.info(summary, "Atlas synchronization completed");
    return summary;
  } finally {
    for (const stageTable of stageTables) {
      await connections.write
        .execute(`DROP TABLE IF EXISTS "${stageTable}"`)
        .catch(() => undefined);
    }
    if (duckdb !== undefined) {
      if (targetAttached) {
        await detachAtlasTarget(duckdb.connection).catch(() => undefined);
      }
      duckdb.close();
    }
    await rm(runDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await lock.release();
    if (ownsConnections) {
      await connections.close();
    }
  }
}
