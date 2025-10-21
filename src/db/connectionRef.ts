import type { LibSQLDatabase } from "drizzle-orm/libsql";

let currentDb: LibSQLDatabase | undefined;

export function setDbInstance(db: LibSQLDatabase): void {
    currentDb = db;
}

export function getDbInstance(): LibSQLDatabase | undefined {
    return currentDb;
}


