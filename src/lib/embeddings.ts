import { embedMany, embed } from "ai";
import { openai } from "@ai-sdk/openai";

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
      model: openai.textEmbeddingModel("text-embedding-3-small"),
      value: text,
    });
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
      model: openai.textEmbeddingModel("text-embedding-3-small"),
      values: texts,
    });

    if (embeddings.embeddings.length !== texts.length) {
      throw new Error(
        `Embedding count mismatch: expected ${texts.length}, got ${embeddings.embeddings.length}`,
      );
    }

    return embeddings.embeddings.map((value, index) => ({
      embedding: value,
      text: texts[index],
    }));
  } catch (error) {
    if (error instanceof Error && error.message.includes("mismatch")) {
      throw error;
    }
    throw new Error(
      `Failed to generate embeddings: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}
