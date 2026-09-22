import {
  mkdir,
  open,
  readFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import type { AtlasBackend } from "./backend.ts";
import type { AtlasExecutor } from "./connections.ts";

const POSTGRES_ATLAS_LOCK_ID = 1_163_151_188;

export interface AtlasSyncLock {
  release(): Promise<void>;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const text = await readFile(lockPath, "utf8");
    const pid = Number(JSON.parse(text).pid);
    if (Number.isSafeInteger(pid) && pid > 0 && processIsRunning(pid)) {
      return;
    }
    await unlink(lockPath);
  } catch {
    // A missing or concurrently removed lock needs no cleanup.
  }
}

async function openSqliteLock(
  backend: Extract<AtlasBackend, { kind: "sqlite" }>,
): Promise<{ handle: FileHandle; lockPath: string }> {
  const lockPath = `${backend.filePath}.sync.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });

  try {
    return {
      handle: await open(lockPath, "wx", 0o600),
      lockPath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  await removeStaleLock(lockPath);
  try {
    return {
      handle: await open(lockPath, "wx", 0o600),
      lockPath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Atlas synchronization is already running");
    }
    throw error;
  }
}

export async function acquireAtlasSyncLock(
  backend: AtlasBackend,
  executor: AtlasExecutor,
): Promise<AtlasSyncLock> {
  if (backend.kind === "postgres") {
    const result = await executor.execute(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [POSTGRES_ATLAS_LOCK_ID],
    );
    if (result.rows[0]?.acquired !== true) {
      throw new Error("Atlas synchronization is already running");
    }
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        await executor.execute("SELECT pg_advisory_unlock($1)", [
          POSTGRES_ATLAS_LOCK_ID,
        ]);
      },
    };
  }

  const { handle, lockPath } = await openSqliteLock(backend);
  await handle.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    },
  };
}
