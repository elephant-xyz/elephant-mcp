import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { existsSync } from "node:fs";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { logger } from "../logger.js";
import { fileURLToPath } from "node:url";

export async function initializeDatabase(dbPath: string) {
  const isNewDatabase = !existsSync(dbPath);

  if (isNewDatabase) {
    logger.info({ dbPath }, "Database does not exist, creating new database");
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  } else {
    logger.info({ dbPath }, "Database exists, checking for pending migrations");
  }

  const client = createClient({
    url: `file:${dbPath}`,
  });

  const db = drizzle(client);
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));

  // Try to resolve package root by walking up to the package.json with our package name
  async function findPackageRoot(
    startDir: string,
  ): Promise<string | undefined> {
    let current = startDir;
    const root = path.parse(startDir).root;
    while (true) {
      const pkgPath = path.join(current, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkgRaw = await readFile(pkgPath, "utf8");
          const pkg = JSON.parse(pkgRaw) as { name?: string };
          if (pkg && pkg.name === "@elephant-xyz/mcp") {
            return current;
          }
        } catch {
          // ignore and continue walking up
        }
      }
      if (current === root) break;
      current = path.dirname(current);
    }
    return undefined;
  }

  const pkgRoot = await findPackageRoot(moduleDir);
  const candidateFromPkgRoot = pkgRoot
    ? path.join(pkgRoot, "drizzle")
    : undefined;
  const candidateFromTwoUp = path.join(moduleDir, "../../drizzle");
  const candidateFromThreeUp = path.join(moduleDir, "../../../drizzle");

  let migrationsFolder = candidateFromTwoUp;
  if (!existsSync(path.join(migrationsFolder, "meta/_journal.json"))) {
    if (
      candidateFromPkgRoot &&
      existsSync(path.join(candidateFromPkgRoot, "meta/_journal.json"))
    ) {
      migrationsFolder = candidateFromPkgRoot;
    } else if (
      existsSync(path.join(candidateFromThreeUp, "meta/_journal.json"))
    ) {
      migrationsFolder = candidateFromThreeUp;
    }
  }

  try {
    logger.info("Applying migrations");
    await migrate(db, { migrationsFolder });
    logger.info("Migrations applied successfully");
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        migrationsFolder,
        pkgRoot,
        candidateFromTwoUp,
        candidateFromThreeUp,
      },
      "Failed to apply migrations",
    );
    throw error;
  }

  return { db, client, isNewDatabase };
}
