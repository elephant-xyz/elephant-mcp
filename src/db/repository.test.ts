import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initializeDatabase } from "./migrate.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  saveFunction,
  getFunctionById,
  getFunctionsByFilePath,
  searchSimilar,
  deleteFunction,
} from "./repository.js";
import type { FunctionInput } from "./types.js";

const VECTOR_DIMS = 1536;
const createTestEmbedding = (): number[] => {
  return Array.from({ length: VECTOR_DIMS }, (_, i) => (i % 100) / 100);
};

const createTestEmbedding2 = (): number[] => {
  return Array.from({ length: VECTOR_DIMS }, (_, i) => ((i + 50) % 100) / 100);
};

const createTestEmbedding3 = (): number[] => {
  return Array.from({ length: VECTOR_DIMS }, (_, i) => ((i + 25) % 100) / 100);
};

describe("repository", () => {
  let testDbPath: string;
  let db: Awaited<ReturnType<typeof initializeDatabase>>["db"];
  let client: Awaited<ReturnType<typeof initializeDatabase>>["client"];

  beforeEach(async () => {
    testDbPath = join(
      tmpdir(),
      `repository-test-${process.pid}-${randomUUID()}.sqlite`,
    );
    const result = await initializeDatabase(testDbPath);
    db = result.db;
    client = result.client;
  });

  afterEach(() => {
    client.close();
    if (testDbPath && existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  describe("saveFunction", () => {
    it("should save a function with single embedding", async () => {
      const input: FunctionInput = {
        name: "testFunction",
        code: "function test() { return 42; }",
        filePath: "/src/test.ts",
        embeddings: [createTestEmbedding()],
      };

      const result = await saveFunction(db, input);

      expect(result.id).toBeGreaterThan(0);
      expect(result.name).toBe(input.name);
      expect(result.code).toBe(input.code);
      expect(result.filePath).toBe(input.filePath);
      expect(result.embeddings).toHaveLength(1);
      expect(result.embeddings[0]).toEqual(input.embeddings[0]);
    });

    it("should save a function with multiple embeddings", async () => {
      const input: FunctionInput = {
        name: "complexFunction",
        code: "function complex() { /* long code */ }",
        filePath: "/src/complex.ts",
        embeddings: [
          createTestEmbedding(),
          createTestEmbedding2(),
          createTestEmbedding3(),
        ],
      };

      const result = await saveFunction(db, input);

      expect(result.embeddings).toHaveLength(3);
      expect(result.embeddings[0]).toEqual(input.embeddings[0]);
      expect(result.embeddings[1]).toEqual(input.embeddings[1]);
      expect(result.embeddings[2]).toEqual(input.embeddings[2]);
    });

    it("should throw error for empty name", async () => {
      const input: FunctionInput = {
        name: "",
        code: "function test() {}",
        filePath: "/src/test.ts",
        embeddings: [createTestEmbedding()],
      };

      await expect(saveFunction(db, input)).rejects.toThrow(
        "Function name is required",
      );
    });

    it("should throw error for empty code", async () => {
      const input: FunctionInput = {
        name: "testFunction",
        code: "",
        filePath: "/src/test.ts",
        embeddings: [createTestEmbedding()],
      };

      await expect(saveFunction(db, input)).rejects.toThrow(
        "Function code is required",
      );
    });

    it("should throw error for empty filePath", async () => {
      const input: FunctionInput = {
        name: "testFunction",
        code: "function test() {}",
        filePath: "",
        embeddings: [createTestEmbedding()],
      };

      await expect(saveFunction(db, input)).rejects.toThrow(
        "Function filePath is required",
      );
    });

    it("should throw error for empty embeddings array", async () => {
      const input: FunctionInput = {
        name: "testFunction",
        code: "function test() {}",
        filePath: "/src/test.ts",
        embeddings: [],
      };

      await expect(saveFunction(db, input)).rejects.toThrow(
        "At least one embedding is required",
      );
    });

    it("should throw error for invalid embedding", async () => {
      const input: FunctionInput = {
        name: "testFunction",
        code: "function test() {}",
        filePath: "/src/test.ts",
        embeddings: [[]],
      };

      await expect(saveFunction(db, input)).rejects.toThrow(
        "Each embedding must be a non-empty array",
      );
    });
  });

  describe("getFunctionById", () => {
    it("should retrieve function with embeddings", async () => {
      const input: FunctionInput = {
        name: "testFunction",
        code: "function test() {}",
        filePath: "/src/test.ts",
        embeddings: [createTestEmbedding(), createTestEmbedding2()],
      };

      const saved = await saveFunction(db, input);
      const retrieved = await getFunctionById(db, saved.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(saved.id);
      expect(retrieved?.name).toBe(input.name);
      expect(retrieved?.code).toBe(input.code);
      expect(retrieved?.filePath).toBe(input.filePath);
      expect(retrieved?.embeddings).toHaveLength(2);

      retrieved?.embeddings[0]?.forEach((val, idx) => {
        expect(val).toBeCloseTo(input.embeddings[0]![idx]!, 5);
      });
      retrieved?.embeddings[1]?.forEach((val, idx) => {
        expect(val).toBeCloseTo(input.embeddings[1]![idx]!, 5);
      });
    });

    it("should return null for non-existent function", async () => {
      const result = await getFunctionById(db, 9999);
      expect(result).toBeNull();
    });

    it("should throw error for invalid ID", async () => {
      await expect(getFunctionById(db, -1)).rejects.toThrow(
        "Invalid function ID",
      );
      await expect(getFunctionById(db, 0)).rejects.toThrow(
        "Invalid function ID",
      );
    });

    it("should preserve embedding order", async () => {
      const input: FunctionInput = {
        name: "testFunction",
        code: "function test() {}",
        filePath: "/src/test.ts",
        embeddings: [
          createTestEmbedding(),
          createTestEmbedding2(),
          createTestEmbedding3(),
        ],
      };

      const saved = await saveFunction(db, input);
      const retrieved = await getFunctionById(db, saved.id);

      retrieved?.embeddings[0]?.forEach((val, idx) => {
        expect(val).toBeCloseTo(input.embeddings[0]![idx]!, 5);
      });
      retrieved?.embeddings[1]?.forEach((val, idx) => {
        expect(val).toBeCloseTo(input.embeddings[1]![idx]!, 5);
      });
      retrieved?.embeddings[2]?.forEach((val, idx) => {
        expect(val).toBeCloseTo(input.embeddings[2]![idx]!, 5);
      });
    });
  });

  describe("getFunctionsByFilePath", () => {
    it("should retrieve all functions from a file", async () => {
      const filePath = "/src/utils.ts";

      await saveFunction(db, {
        name: "function1",
        code: "function f1() {}",
        filePath,
        embeddings: [createTestEmbedding()],
      });

      await saveFunction(db, {
        name: "function2",
        code: "function f2() {}",
        filePath,
        embeddings: [createTestEmbedding2()],
      });

      await saveFunction(db, {
        name: "otherFunction",
        code: "function other() {}",
        filePath: "/src/other.ts",
        embeddings: [createTestEmbedding3()],
      });

      const results = await getFunctionsByFilePath(db, filePath);

      expect(results).toHaveLength(2);
      expect(results[0]?.name).toBe("function1");
      expect(results[1]?.name).toBe("function2");
    });

    it("should return empty array for non-existent file", async () => {
      const results = await getFunctionsByFilePath(db, "/non/existent.ts");
      expect(results).toHaveLength(0);
    });

    it("should throw error for empty filePath", async () => {
      await expect(getFunctionsByFilePath(db, "")).rejects.toThrow(
        "File path is required",
      );
    });
  });

  describe("searchSimilar", () => {
    it("should find similar embeddings", async () => {
      const emb1 = createTestEmbedding();
      const emb2 = createTestEmbedding2();
      const emb3 = createTestEmbedding3();

      await saveFunction(db, {
        name: "function1",
        code: "function f1() {}",
        filePath: "/src/f1.ts",
        embeddings: [emb1],
      });

      await saveFunction(db, {
        name: "function2",
        code: "function f2() {}",
        filePath: "/src/f2.ts",
        embeddings: [emb2],
      });

      await saveFunction(db, {
        name: "function3",
        code: "function f3() {}",
        filePath: "/src/f3.ts",
        embeddings: [emb3],
      });

      const results = await searchSimilar(db, emb1, 2);

      expect(results).toHaveLength(2);
      expect(results[0]?.function.name).toBe("function1");
      expect(results[0]?.distance).toBeDefined();
      expect(typeof results[0]?.distance).toBe("number");
    });

    it("should respect topK limit", async () => {
      for (let i = 0; i < 5; i++) {
        await saveFunction(db, {
          name: `function${i}`,
          code: `function f${i}() {}`,
          filePath: `/src/f${i}.ts`,
          embeddings: [createTestEmbedding()],
        });
      }

      const results = await searchSimilar(db, createTestEmbedding(), 3);

      expect(results).toHaveLength(3);
    });

    it("should throw error for empty embedding", async () => {
      await expect(searchSimilar(db, [], 5)).rejects.toThrow(
        "Embedding must be a non-empty array",
      );
    });

    it("should throw error for invalid topK", async () => {
      await expect(searchSimilar(db, createTestEmbedding(), 0)).rejects.toThrow(
        "topK must be a positive integer",
      );

      await expect(
        searchSimilar(db, createTestEmbedding(), -1),
      ).rejects.toThrow("topK must be a positive integer");
    });
  });

  describe("deleteFunction", () => {
    it("should delete function and its embeddings", async () => {
      const saved = await saveFunction(db, {
        name: "testFunction",
        code: "function test() {}",
        filePath: "/src/test.ts",
        embeddings: [createTestEmbedding(), createTestEmbedding2()],
      });

      await deleteFunction(db, saved.id);

      const retrieved = await getFunctionById(db, saved.id);
      expect(retrieved).toBeNull();
    });

    it("should not throw error for non-existent function", async () => {
      await expect(deleteFunction(db, 9999)).resolves.not.toThrow();
    });

    it("should throw error for invalid ID", async () => {
      await expect(deleteFunction(db, -1)).rejects.toThrow(
        "Invalid function ID",
      );
      await expect(deleteFunction(db, 0)).rejects.toThrow(
        "Invalid function ID",
      );
    });
  });

  describe("transaction rollback", () => {
    it("should rollback on error during save", async () => {
      const invalidInput = {
        name: "testFunction",
        code: "function test() {}",
        filePath: "/src/test.ts",
        embeddings: [createTestEmbedding(), []],
      };

      await expect(saveFunction(db, invalidInput)).rejects.toThrow();

      const results = await getFunctionsByFilePath(db, "/src/test.ts");
      expect(results).toHaveLength(0);
    });
  });
});
