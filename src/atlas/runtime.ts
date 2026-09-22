import { getConfig } from "../config.ts";
import { logger } from "../logger.ts";
import { parseAtlasDatabaseUrl, type AtlasBackend } from "./backend.ts";
import { openAtlasConnections, type AtlasConnections } from "./connections.ts";
import { initializeAtlasSchema } from "./schema.ts";
import { syncAtlas, type AtlasSyncSummary } from "./sync.ts";

export type AtlasRuntimeStatus =
  | "uninitialized"
  | "syncing"
  | "ready"
  | "stale"
  | "error";

export interface AtlasRuntime {
  backend: AtlasBackend;
  connections: AtlasConnections;
  status: AtlasRuntimeStatus;
  sync?: Promise<AtlasSyncSummary>;
  error?: string;
}

let runtimePromise: Promise<AtlasRuntime> | undefined;

async function hasAcceptedSnapshot(
  connections: AtlasConnections,
): Promise<boolean> {
  try {
    const rows = await connections.read(
      "SELECT index_cid FROM atlas_sync_state WHERE singleton_key = 1",
    );
    return rows.length === 1;
  } catch {
    return false;
  }
}

export function initializeAtlasRuntime(options: {
  startLocalSync: boolean;
}): Promise<AtlasRuntime> {
  runtimePromise ??= (async () => {
    const config = getConfig();
    const backend = parseAtlasDatabaseUrl(config.DATABASE_URL);
    const connections = await openAtlasConnections(backend);
    if (options.startLocalSync && backend.kind === "sqlite") {
      await initializeAtlasSchema(connections.write);
      const runtime: AtlasRuntime = {
        backend,
        connections,
        status: "syncing",
      };
      runtime.sync = syncAtlas({
        connections,
        databaseUrl: backend.databaseUrl,
      })
        .then((summary) => {
          runtime.status = "ready";
          return summary;
        })
        .catch(async (error) => {
          runtime.error =
            error instanceof Error ? error.message : String(error);
          runtime.status = (await hasAcceptedSnapshot(connections))
            ? "stale"
            : "error";
          logger.error(
            { error: runtime.error },
            "Atlas startup synchronization failed",
          );
          throw error;
        });
      // Keep rejection handled even when no Atlas-backed tool awaits startup.
      void runtime.sync.catch(() => undefined);
      return runtime;
    }

    return {
      backend,
      connections,
      status: (await hasAcceptedSnapshot(connections))
        ? "ready"
        : "uninitialized",
    };
  })();
  return runtimePromise;
}

async function getAtlasRuntime(): Promise<AtlasRuntime> {
  return runtimePromise ?? initializeAtlasRuntime({ startLocalSync: false });
}

/**
 * Resolve once an accepted snapshot can be served. A running sync only
 * blocks callers while there is no snapshot yet; otherwise reads continue
 * against the accepted snapshot and the sync lands in the background.
 */
export async function awaitAtlasReady(): Promise<AtlasRuntime> {
  const runtime = await getAtlasRuntime();
  if (
    runtime.status === "syncing" &&
    runtime.sync !== undefined &&
    !(await hasAcceptedSnapshot(runtime.connections))
  ) {
    // The status below distinguishes stale data from an uninitialized store.
    await runtime.sync.catch(() => undefined);
  }
  if (
    (runtime.status === "uninitialized" || runtime.status === "error") &&
    (await hasAcceptedSnapshot(runtime.connections))
  ) {
    // A separate sync job (hosted mode) landed a snapshot after startup.
    runtime.status = runtime.status === "error" ? "stale" : "ready";
  }
  if (runtime.status === "uninitialized" || runtime.status === "error") {
    throw new Error(
      runtime.error === undefined
        ? "ATLAS_NOT_INITIALIZED"
        : `ATLAS_NOT_INITIALIZED: ${runtime.error}`,
    );
  }
  return runtime;
}

/** Tests inject a runtime (or clear it with no argument). */
export function setAtlasRuntimeForTests(runtime?: AtlasRuntime): void {
  runtimePromise = runtime && Promise.resolve(runtime);
}
