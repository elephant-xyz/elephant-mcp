import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { eq, sql } from "drizzle-orm";
import {
  functionsTable,
  functionEmbeddingsTable,
  indexStateTable,
} from "./schema.js";
import type {
  FunctionInput,
  FunctionWithChunks,
  VectorSearchResult,
} from "./types.js";

const EMBEDDING_DIMENSION = 1536;

export async function saveFunction(
  db: LibSQLDatabase,
  input: FunctionInput,
): Promise<FunctionWithChunks> {
  if (!input.name || input.name.trim().length === 0) {
    throw new Error("Function name is required");
  }

  if (!input.code || input.code.trim().length === 0) {
    throw new Error("Function code is required");
  }

  if (!input.filePath || input.filePath.trim().length === 0) {
    throw new Error("Function filePath is required");
  }

  if (!input.embeddings || input.embeddings.length === 0) {
    throw new Error("At least one embedding is required");
  }

  for (const embedding of input.embeddings) {
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `Each embedding must be an array of length ${EMBEDDING_DIMENSION}`,
      );
    }

    if (
      embedding.some(
        (value) => typeof value !== "number" || Number.isNaN(value),
      )
    ) {
      throw new Error("Each embedding must only contain numbers");
    }
  }

  return await db.transaction(async (tx) => {
    const [insertedFunction] = await tx
      .insert(functionsTable)
      .values({
        name: input.name,
        code: input.code,
        filePath: input.filePath,
      })
      .returning();

    if (!insertedFunction) {
      throw new Error("Failed to insert function");
    }

    for (let index = 0; index < input.embeddings.length; index++) {
      const embedding = input.embeddings[index];
      if (!embedding) continue;

      await tx.run(
        sql`INSERT INTO ${functionEmbeddingsTable} (functionId, chunkIndex, vector) VALUES (${insertedFunction.id}, ${index}, vector32(${JSON.stringify(embedding)}))`,
      );
    }

    return {
      id: insertedFunction.id,
      name: insertedFunction.name,
      code: insertedFunction.code,
      filePath: insertedFunction.filePath,
      embeddings: input.embeddings,
    };
  });
}

export async function getFunctionById(
  db: LibSQLDatabase,
  id: number,
): Promise<FunctionWithChunks | null> {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Invalid function ID");
  }

  const [func] = await db
    .select()
    .from(functionsTable)
    .where(eq(functionsTable.id, id));

  if (!func) {
    return null;
  }

  const chunks = await db
    .select()
    .from(functionEmbeddingsTable)
    .where(eq(functionEmbeddingsTable.functionId, id))
    .orderBy(functionEmbeddingsTable.chunkIndex);

  return {
    id: func.id,
    name: func.name,
    code: func.code,
    filePath: func.filePath,
    embeddings: chunks.map((chunk) => chunk.embedding),
  };
}

export async function getFunctionsByFilePath(
  db: LibSQLDatabase,
  filePath: string,
): Promise<FunctionWithChunks[]> {
  if (!filePath || filePath.trim().length === 0) {
    throw new Error("File path is required");
  }

  const functions = await db
    .select()
    .from(functionsTable)
    .where(eq(functionsTable.filePath, filePath));

  if (functions.length === 0) {
    return [];
  }

  const functionIds = functions.map((f) => f.id);

  const allChunks = await db
    .select()
    .from(functionEmbeddingsTable)
    .where(sql`${functionEmbeddingsTable.functionId} IN ${functionIds}`)
    .orderBy(
      functionEmbeddingsTable.functionId,
      functionEmbeddingsTable.chunkIndex,
    );

  const chunksByFunctionId = new Map<number, typeof allChunks>();
  for (const chunk of allChunks) {
    if (!chunksByFunctionId.has(chunk.functionId)) {
      chunksByFunctionId.set(chunk.functionId, []);
    }
    chunksByFunctionId.get(chunk.functionId)!.push(chunk);
  }

  const results: FunctionWithChunks[] = functions.map((func) => ({
    id: func.id,
    name: func.name,
    code: func.code,
    filePath: func.filePath,
    embeddings: (chunksByFunctionId.get(func.id) || []).map(
      (chunk) => chunk.embedding,
    ),
  }));

  return results;
}

export async function searchSimilar(
  db: LibSQLDatabase,
  embedding: number[],
  topK: number,
): Promise<VectorSearchResult[]> {
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Embedding must be an array of length ${EMBEDDING_DIMENSION}`,
    );
  }

  if (
    embedding.some((value) => typeof value !== "number" || Number.isNaN(value))
  ) {
    throw new Error("Embedding must only contain numbers");
  }

  if (!Number.isInteger(topK) || topK <= 0) {
    throw new Error("topK must be a positive integer");
  }

  const embeddingJson = JSON.stringify(embedding);

  const rawResults = await db.all<{
    id: number;
    distance: number;
    functionId: number;
  }>(
    sql.raw(`
      SELECT 
        fe.id,
        fe.functionId,
        vector_distance_cos(fe.vector, vector32('${embeddingJson}')) as distance
      FROM functionEmbeddings fe
      ORDER BY distance
      LIMIT ${topK}
    `),
  );

  const functionMap = new Map<number, FunctionWithChunks>();

  for (const result of rawResults) {
    if (result.functionId && !functionMap.has(result.functionId)) {
      const func = await getFunctionById(db, result.functionId);
      if (func) {
        functionMap.set(result.functionId, func);
      }
    }
  }

  return rawResults
    .map((result) => {
      if (!result.functionId) return null;
      const func = functionMap.get(result.functionId);
      if (!func) return null;
      return { functionWithChunks: func, distance: result.distance };
    })
    .filter((r): r is VectorSearchResult => r !== null);
}

export async function deleteFunction(
  db: LibSQLDatabase,
  id: number,
): Promise<void> {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Invalid function ID");
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(functionEmbeddingsTable)
      .where(eq(functionEmbeddingsTable.functionId, id));

    await tx.delete(functionsTable).where(eq(functionsTable.id, id));
  });
}

export interface IndexState {
  repoPath: string;
  lastIndexedCommit: string;
  updatedAt: number;
}

export async function getIndexState(
  db: LibSQLDatabase,
  repoPath: string,
): Promise<IndexState | null> {
  if (!repoPath || repoPath.trim().length === 0) {
    throw new Error("repoPath is required");
  }

  try {
    const [row] = await db
      .select()
      .from(indexStateTable)
      .where(eq(indexStateTable.repoPath, repoPath));

    if (!row) return null;
    return {
      repoPath: row.repoPath,
      lastIndexedCommit: row.lastIndexedCommit,
      updatedAt: row.updatedAt,
    } as IndexState;
  } catch {
    // If the table does not exist yet (older databases), treat as no state
    return null;
  }
}

export async function setIndexState(
  db: LibSQLDatabase,
  repoPath: string,
  lastIndexedCommit: string,
): Promise<IndexState> {
  if (!repoPath || repoPath.trim().length === 0) {
    throw new Error("repoPath is required");
  }
  if (!lastIndexedCommit || lastIndexedCommit.trim().length === 0) {
    throw new Error("lastIndexedCommit is required");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  await db.run(
    sql`INSERT INTO ${indexStateTable} (repoPath, lastIndexedCommit, updatedAt)
        VALUES (${repoPath}, ${lastIndexedCommit}, ${nowSeconds})
        ON CONFLICT(repoPath) DO UPDATE SET lastIndexedCommit=excluded.lastIndexedCommit, updatedAt=excluded.updatedAt`,
  );

  return {
    repoPath,
    lastIndexedCommit,
    updatedAt: nowSeconds,
  };
}
