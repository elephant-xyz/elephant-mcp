import { embedMany, embed } from "ai";
import { openai } from "@ai-sdk/openai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { getEmbeddingProvider, getConfig } from "../config.ts";

// Both providers are configured to output 1024 dimensions
// OpenAI text-embedding-3-small supports custom dimensions via API parameter
// Amazon Titan Embed Text V2 outputs 1024 dimensions by default
export const EMBEDDING_DIM = 1024;

// Model IDs
const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const BEDROCK_EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";

// Cached Bedrock client (lazy-initialized to avoid issues if AWS_REGION isn't set at import time)
let cachedBedrockClient: ReturnType<typeof createAmazonBedrock> | null = null;

function getBedrockClient() {
  if (!cachedBedrockClient) {
    cachedBedrockClient = createAmazonBedrock({
      region: getConfig().AWS_REGION,
      // Use AWS credential provider chain for proper credential handling
      // in container/ECS/Lambda/EC2 environments with IAM roles
      credentialProvider: fromNodeProviderChain(),
    });
  }
  return cachedBedrockClient;
}

export interface EmbeddingResult {
  embedding: number[];
  text: string;
}

function getEmbeddingModel() {
  const provider = getEmbeddingProvider();
  if (provider === "openai") {
    return openai.textEmbeddingModel(OPENAI_EMBEDDING_MODEL);
  }
  return getBedrockClient().embedding(BEDROCK_EMBEDDING_MODEL);
}

export function getActiveEmbeddingModel(): string {
  const provider = getEmbeddingProvider();
  return provider === "openai"
    ? OPENAI_EMBEDDING_MODEL
    : BEDROCK_EMBEDDING_MODEL;
}

export async function embedText(text: string): Promise<number[]> {
  if (!text || text.trim().length === 0) {
    throw new Error("Text cannot be empty");
  }

  try {
    const result = await embed({
      model: getEmbeddingModel(),
      value: text,
      providerOptions: {
        openai: { dimensions: EMBEDDING_DIM },
      },
    });
    if (result.embedding.length !== EMBEDDING_DIM) {
      throw new Error(
        `Embedding dimension mismatch for ${getActiveEmbeddingModel()}: expected ${EMBEDDING_DIM}, got ${result.embedding.length}`,
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
      model: getEmbeddingModel(),
      values: texts,
      providerOptions: {
        openai: { dimensions: EMBEDDING_DIM },
      },
    });

    if (embeddings.embeddings.length !== texts.length) {
      throw new Error(
        `Embedding count mismatch: expected ${texts.length}, got ${embeddings.embeddings.length}`,
      );
    }

    return embeddings.embeddings.map((value, index) => {
      if (value.length !== EMBEDDING_DIM) {
        throw new Error(
          `Embedding dimension mismatch for ${getActiveEmbeddingModel()}: expected ${EMBEDDING_DIM}, got ${value.length}`,
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
