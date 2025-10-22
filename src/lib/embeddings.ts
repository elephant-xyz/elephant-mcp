import { embedMany, embed } from "ai";
import { openai } from "@ai-sdk/openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIM = 1536;

export interface EmbeddingResult {
  embedding: number[];
  text: string;
}

export async function embedText(text: string): Promise<number[]> {
  if (!text || text.trim().length === 0) {
    throw new Error("Text cannot be empty");
  }

  try {
    const result = await embed({
      model: openai.textEmbeddingModel(EMBEDDING_MODEL),
      value: text,
    });
    if (result.embedding.length !== EMBEDDING_DIM) {
      throw new Error(
        `Embedding dimension mismatch for ${EMBEDDING_MODEL}: expected ${EMBEDDING_DIM}, got ${result.embedding.length}`,
      );
    }
    return result.embedding;
  } catch (error) {
    throw new Error(
      `Failed to generate embedding: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

export async function embedManyTexts(
  texts: string[],
): Promise<EmbeddingResult[]> {
  if (!texts || texts.length === 0) {
    throw new Error("Texts array cannot be empty");
  }

  const invalidTexts = texts.filter((t) => !t || t.trim().length === 0);
  if (invalidTexts.length > 0) {
    throw new Error("All texts must be non-empty strings");
  }

  try {
    const embeddings = await embedMany({
      model: openai.textEmbeddingModel(EMBEDDING_MODEL),
      values: texts,
    });

    if (embeddings.embeddings.length !== texts.length) {
      throw new Error(
        `Embedding count mismatch: expected ${texts.length}, got ${embeddings.embeddings.length}`,
      );
    }

    return embeddings.embeddings.map((value, index) => {
      if (value.length !== EMBEDDING_DIM) {
        throw new Error(
          `Embedding dimension mismatch for ${EMBEDDING_MODEL}: expected ${EMBEDDING_DIM}, got ${value.length}`,
        );
      }

      return {
        embedding: value,
        text: texts[index],
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("mismatch")) {
      throw error;
    }
    throw new Error(
      `Failed to generate embeddings: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}
