import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initializeDatabase } from "./migrate.js";
import { unlinkSync, existsSync } from "node:fs";
import { functionsTable, functionEmbeddingsTable } from "./schema.js";

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
    const { client, isNewDatabase } = await initializeDatabase(testDbPath);

    expect(isNewDatabase).toBe(true);
    expect(existsSync(testDbPath)).toBe(true);

    client.close();
  });

  it("should apply migrations to new database", async () => {
    const { client, isNewDatabase } = await initializeDatabase(testDbPath);

    expect(isNewDatabase).toBe(true);

    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table'",
    );

    expect(tables).toBeDefined();

    client.close();
  });

  it("should connect to existing database", async () => {
    const { client: firstClient } = await initializeDatabase(testDbPath);
    firstClient.close();

    const { client, isNewDatabase } = await initializeDatabase(testDbPath);

    expect(isNewDatabase).toBe(false);
    expect(existsSync(testDbPath)).toBe(true);

    client.close();
  });

  it("should allow database operations after initialization", async () => {
    const { db, client } = await initializeDatabase(testDbPath);

    await db.insert(functionsTable).values({
      name: "testFunction",
      code: "console.log('test')",
      filePath: "/test/path.ts",
    });

    const result = await db.select().from(functionsTable);

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("testFunction");

    client.close();
  });

  it("should support vector embeddings", async () => {
    const { db, client } = await initializeDatabase(testDbPath);

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

    const testVector = Array.from({ length: 1536 }, (_, i) => (i % 100) / 100);

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

    client.close();
  });
});
