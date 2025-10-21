import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { eq, sql } from "drizzle-orm";
import { functionsTable, functionEmbeddingsTable } from "./schema.js";
import type {
  FunctionInput,
  FunctionWithChunks,
  VectorSearchResult,
} from "./types.js";

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
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error("Each embedding must be a non-empty array");
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

    const embeddingRows = input.embeddings.map((embedding, index) => ({
      functionId: insertedFunction.id,
      chunkIndex: index,
      embedding,
    }));

    await tx.insert(functionEmbeddingsTable).values(embeddingRows);

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

  const results: FunctionWithChunks[] = [];

  for (const func of functions) {
    const chunks = await db
      .select()
      .from(functionEmbeddingsTable)
      .where(eq(functionEmbeddingsTable.functionId, func.id))
      .orderBy(functionEmbeddingsTable.chunkIndex);

    results.push({
      id: func.id,
      name: func.name,
      code: func.code,
      filePath: func.filePath,
      embeddings: chunks.map((chunk) => chunk.embedding),
    });
  }

  return results;
}

export async function searchSimilar(
  db: LibSQLDatabase,
  embedding: number[],
  topK: number,
): Promise<VectorSearchResult[]> {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("Embedding must be a non-empty array");
  }

  if (!Number.isInteger(topK) || topK <= 0) {
    throw new Error("topK must be a positive integer");
  }

  const embeddingJson = JSON.stringify(embedding);
  const results = await db
    .select({
      embeddingId: sql<number>`vector_results.id`,
      distance: sql<number>`vector_results.distance`,
      functionId: functionEmbeddingsTable.functionId,
    })
    .from(
      sql.raw(
        `vector_top_k('function_embeddings_vector_idx', vector32('${embeddingJson}'), ${topK}) as vector_results`,
      ),
    )
    .leftJoin(
      functionEmbeddingsTable,
      sql`${functionEmbeddingsTable.id} = vector_results.id`,
    );

  const functionMap = new Map<number, FunctionWithChunks>();

  for (const result of results) {
    if (result.functionId && !functionMap.has(result.functionId)) {
      const func = await getFunctionById(db, result.functionId);
      if (func) {
        functionMap.set(result.functionId, func);
      }
    }
  }

  return results
    .map((result) => {
      if (!result.functionId) return null;
      const func = functionMap.get(result.functionId);
      if (!func) return null;
      return {
        function: func,
        distance: result.distance,
      };
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
