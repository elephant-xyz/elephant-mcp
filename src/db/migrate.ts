import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { logger } from "../logger.js";

export async function initializeDatabase(dbPath: string) {
  const isNewDatabase = !existsSync(dbPath);

  if (isNewDatabase) {
    logger.info({ dbPath }, "Database does not exist, creating new database");
    const dir = dirname(dbPath);
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

  try {
    logger.info("Applying migrations");
    await migrate(db, { migrationsFolder: "./drizzle" });
    logger.info("Migrations applied successfully");
  } catch (error) {
    logger.error({ error }, "Failed to apply migrations");
    throw error;
  }

  return { db, client, isNewDatabase };
}
