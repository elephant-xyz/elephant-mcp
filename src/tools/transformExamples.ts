import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";
import { embedText } from "../lib/embeddings.ts";
import { getDbInstance } from "../db/connectionRef.ts";
import { searchSimilar } from "../db/repository.ts";
import { getConfig } from "../config.ts";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export async function transformExamplesHandler(text: string, topK?: number) {
  try {
    const { OPENAI_API_KEY } = getConfig();
    if (!OPENAI_API_KEY || OPENAI_API_KEY.length === 0) {
      return createTextResult({ error: "Missing OPENAI_API_KEY" });
    }

    if (!text || text.trim().length === 0) {
      return createTextResult({ error: "Text cannot be empty" });
    }

    const db = getDbInstance();
    if (!db) {
      return createTextResult({ error: "Database is not initialized" });
    }

    const embedding = await embedText(text);
    const k = clamp(typeof topK === "number" ? topK : 5, 1, 50);
    const results = await searchSimilar(db, embedding, k);

    const matches = results.map((r) => ({
      name: r.functionWithChunks.name,
      code: r.functionWithChunks.code,
    }));

    return createTextResult({ count: matches.length, matches });
  } catch (error) {
    logger.error("transformExamples failed", {
      error: error instanceof Error ? error.message : String(error),
      textLength: typeof text === "string" ? text.length : undefined,
      topK,
    });
    return createTextResult({ error: "Failed to transform examples" });
  }
}
