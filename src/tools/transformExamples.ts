import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";
import { embedText } from "../lib/embeddings.ts";
import { getDbInstance } from "../db/connectionRef.ts";
import { searchSimilar } from "../db/repository.ts";
import {
  hasEmbeddingProvider,
  getEmbeddingProviderDescription,
} from "../config.ts";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export async function transformExamplesHandler(text: string, topK?: number) {
  try {
    if (!text || text.trim().length === 0) {
      return createTextResult({ error: "Text cannot be empty" });
    }

    const db = getDbInstance();
    if (!db) {
      return createTextResult({ error: "Database is not initialized" });
    }

    // Check if embedding provider is configured before attempting to generate embeddings
    if (!hasEmbeddingProvider()) {
      return createTextResult({
        error:
          "No embedding provider configured. Set OPENAI_API_KEY or configure AWS credentials for Bedrock.",
      });
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    const providerDescription = getEmbeddingProviderDescription();

    logger.error(
      {
        error: errorMessage,
        textLength: typeof text === "string" ? text.length : undefined,
        topK,
        embeddingProvider: providerDescription,
      },
      "transformExamples failed",
    );

    // Provide more helpful error messages for common issues
    if (
      errorMessage.includes("credential") ||
      errorMessage.includes("Credential") ||
      errorMessage.includes("AccessDenied") ||
      errorMessage.includes("UnauthorizedException")
    ) {
      return createTextResult({
        error: `Embedding provider authentication failed (${providerDescription}). Check your credentials and permissions.`,
        details: errorMessage,
      });
    }

    return createTextResult({
      error: "Failed to transform examples",
      details: errorMessage,
    });
  }
}
