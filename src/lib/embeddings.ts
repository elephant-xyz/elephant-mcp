import { embedMany, embed } from "ai";
import { openai } from "@ai-sdk/openai";

export async function embedText(text: string): Promise<number[]> {
  return (
    await embed({
      model: openai.textEmbeddingModel("text-embedding-3-small"),
      value: text,
    })
  ).embedding;
}

export async function embedManyTexts(texts: string[]) {
  const embeddings = await embedMany({
    model: openai.textEmbeddingModel("text-embedding-3-small"),
    values: texts,
  });
  return embeddings.embeddings.map((value, index) => ({
    embedding: value,
    text: texts[index],
  }));
}
