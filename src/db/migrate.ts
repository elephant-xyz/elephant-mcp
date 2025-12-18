import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { existsSync } from "node:fs";
import path from "node:path";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { logger } from "../logger.js";
import { fileURLToPath } from "node:url";
import { EMBEDDING_DIM } from "../lib/embeddings.js";

/**
 * Check if the database has a dimension mismatch with the current embedding model.
 * Returns the database dimension if found, or null if table doesn't exist or is empty.
 */
async function getDatabaseEmbeddingDimension(
  client: Client,
): Promise<number | null> {
  try {
    // Check table schema for the vector column type
    const schemaResult = await client.execute(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='functionEmbeddings'",
    );

    if (schemaResult.rows.length === 0) {
      return null; // Table doesn't exist
    }

    const createSql = schemaResult.rows[0]?.sql as string | undefined;
    if (!createSql) {
      return null;
    }

    // Parse F32_BLOB(N) from the schema
    const match = createSql.match(/F32_BLOB\((\d+)\)/i);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check if the database needs to be rebuilt due to dimension mismatch.
 */
async function checkDimensionCompatibility(
  client: Client,
  dbPath: string,
): Promise<{ compatible: boolean; dbDimension?: number }> {
  const dbDimension = await getDatabaseEmbeddingDimension(client);

  if (dbDimension === null) {
    // No existing embeddings table, compatible
    return { compatible: true };
  }

  if (dbDimension !== EMBEDDING_DIM) {
    logger.warn(
      {
        dbDimension,
        expectedDimension: EMBEDDING_DIM,
        dbPath,
      },
      "Embedding dimension mismatch detected - database needs rebuild",
    );
    return { compatible: false, dbDimension };
  }

  return { compatible: true, dbDimension };
}

export async function initializeDatabase(dbPath: string) {
  let isNewDatabase = !existsSync(dbPath);
  let dimensionMismatchRebuild = false;

  if (isNewDatabase) {
    logger.info({ dbPath }, "Database does not exist, creating new database");
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  } else {
    logger.info({ dbPath }, "Database exists, checking for pending migrations");

    // Check for dimension mismatch before proceeding
    const tempClient = createClient({ url: `file:${dbPath}` });
    try {
      const compatibility = await checkDimensionCompatibility(
        tempClient,
        dbPath,
      );
      if (!compatibility.compatible) {
        logger.warn(
          {
            dbPath,
            dbDimension: compatibility.dbDimension,
            expectedDimension: EMBEDDING_DIM,
          },
          "Deleting database due to embedding dimension mismatch - will rebuild with correct dimensions",
        );
        tempClient.close();

        // Delete the old database
        await unlink(dbPath);
        isNewDatabase = true;
        dimensionMismatchRebuild = true;

        // Ensure directory exists
        const dir = path.dirname(dbPath);
        if (!existsSync(dir)) {
          await mkdir(dir, { recursive: true });
        }
      } else {
        tempClient.close();
      }
    } catch (error) {
      try {
        tempClient.close();
      } catch {
        // Ignore close errors to preserve original error
      }
      throw error;
    }
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

  const candidateEntries = [
    { label: "candidateFromTwoUp", path: candidateFromTwoUp },
    candidateFromPkgRoot
      ? { label: "candidateFromPkgRoot", path: candidateFromPkgRoot }
      : undefined,
    { label: "candidateFromThreeUp", path: candidateFromThreeUp },
  ].filter(Boolean) as Array<{ label: string; path: string }>;

  const resolvedCandidate = candidateEntries.find(({ path: candidatePath }) =>
    existsSync(path.join(candidatePath, "meta/_journal.json")),
  );

  if (!resolvedCandidate) {
    const attemptedPaths = candidateEntries
      .map(({ label, path: candidatePath }) => `${label}: ${candidatePath}`)
      .join(", ");
    throw new Error(
      `Unable to locate Drizzle migrations folder; meta/_journal.json not found in any candidate paths (${attemptedPaths}).`,
    );
  }

  const migrationsFolder = resolvedCandidate.path;

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

  return { db, client, isNewDatabase, dimensionMismatchRebuild };
}
