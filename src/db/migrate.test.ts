import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync, existsSync } from "node:fs";
import { initializeDatabase } from "./migrate.js";
import { functionsTable, functionEmbeddingsTable } from "./schema.js";

type DatabaseClient = Awaited<ReturnType<typeof initializeDatabase>>["client"];

describe("initializeDatabase", () => {
  const testDbPath = "./test-db.sqlite";

  beforeEach(() => {
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  afterEach(() => {
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  it("should create a new database if it does not exist", async () => {
    let client: DatabaseClient | undefined;

    try {
      const { client: dbClient, isNewDatabase } =
        await initializeDatabase(testDbPath);
      client = dbClient;

      expect(isNewDatabase).toBe(true);
      expect(existsSync(testDbPath)).toBe(true);
    } finally {
      client?.close();
    }
  });

  it("should apply migrations to new database", async () => {
    let client: DatabaseClient | undefined;

    try {
      const { client: dbClient, isNewDatabase } =
        await initializeDatabase(testDbPath);
      client = dbClient;

      expect(isNewDatabase).toBe(true);

      const tablesResult = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      );
      const indexesResult = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
      );

      const tableNames = tablesResult.rows
        .map((row) => row.name as string)
        .filter((name): name is string => typeof name === "string")
        .sort();
      const indexNames = indexesResult.rows
        .map((row) => row.name as string)
        .filter((name): name is string => typeof name === "string")
        .sort();

      expect(tableNames).toEqual([
        "__drizzle_migrations",
        "functionEmbeddings",
        "function_embeddings_vector_idx_shadow",
        "functions",
        "libsql_vector_meta_shadow",
      ]);
      expect(indexNames).toEqual([
        "function_embeddings_vector_idx",
        "function_embeddings_vector_idx_shadow_idx",
      ]);
    } finally {
      client?.close();
    }
  });

  it("should connect to existing database", async () => {
    let firstClient: DatabaseClient | undefined;
    let client: DatabaseClient | undefined;

    try {
      const firstInitialization = await initializeDatabase(testDbPath);
      firstClient = firstInitialization.client;

      firstClient?.close();
      firstClient = undefined;

      const { client: dbClient, isNewDatabase } =
        await initializeDatabase(testDbPath);
      client = dbClient;

      expect(isNewDatabase).toBe(false);
      expect(existsSync(testDbPath)).toBe(true);
    } finally {
      firstClient?.close();
      client?.close();
    }
  });

  it("should allow database operations after initialization", async () => {
    let client: DatabaseClient | undefined;

    try {
      const { db, client: dbClient } = await initializeDatabase(testDbPath);
      client = dbClient;

      await db.insert(functionsTable).values({
        name: "testFunction",
        code: "console.log('test')",
        filePath: "/test/path.ts",
      });

      const result = await db.select().from(functionsTable);

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("testFunction");
    } finally {
      client?.close();
    }
  });

  it("should support vector embeddings", async () => {
    let client: DatabaseClient | undefined;

    try {
      const { db, client: dbClient } = await initializeDatabase(testDbPath);
      client = dbClient;

      await db.insert(functionsTable).values({
        name: "testFunction",
        code: "console.log('test')",
        filePath: "/test/path.ts",
      });

      const functions = await db.select().from(functionsTable);
      const functionId = functions[0]?.id;

      if (!functionId) {
        throw new Error("Function not inserted");
      }

      const testVector = Array.from(
        { length: 1536 },
        (_, i) => (i % 100) / 100,
      );

      await client.execute({
        sql: `INSERT INTO functionEmbeddings (functionId, chunkIndex, vector) VALUES (?, ?, vector32(?))`,
        args: [functionId, 0, JSON.stringify(testVector)],
      });

      const embeddings = await db.select().from(functionEmbeddingsTable);

      expect(embeddings).toHaveLength(1);
      expect(embeddings[0]?.functionId).toBe(functionId);

      const retrievedVector = embeddings[0]?.embedding;
      expect(retrievedVector).toHaveLength(1536);
      expect(retrievedVector?.[0]).toBeCloseTo(testVector[0]!, 2);
      expect(retrievedVector?.[1]).toBeCloseTo(testVector[1]!, 2);
      expect(retrievedVector?.[2]).toBeCloseTo(testVector[2]!, 2);
    } finally {
      client?.close();
    }
  });
});
