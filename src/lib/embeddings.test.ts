import { describe, it, expect, vi, beforeEach } from "vitest";
import { embedText, embedManyTexts, EMBEDDING_DIM } from "./embeddings.ts";

vi.mock("ai", () => ({
  embed: vi.fn(),
  embedMany: vi.fn(),
}));

vi.mock("@ai-sdk/openai", () => ({
  openai: {
    textEmbeddingModel: vi.fn(() => "mocked-model"),
  },
}));

const { embed, embedMany } = await import("ai");

const createEmbedding = (seed = 0) =>
  Array.from(
    { length: EMBEDDING_DIM },
    (_, index) => seed + index / EMBEDDING_DIM,
  );

describe("embedText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return embedding array for valid text", async () => {
    const mockEmbedding = createEmbedding(0.1);
    vi.mocked(embed).mockResolvedValue({
      embedding: mockEmbedding,
      value: "test text",
      usage: { tokens: 2 },
    });

    const result = await embedText("test text");

    expect(result).toEqual(mockEmbedding);
    expect(embed).toHaveBeenCalledWith({
      model: "mocked-model",
      value: "test text",
    });
  });

  it("should throw error for empty string", async () => {
    await expect(embedText("")).rejects.toThrow("Text cannot be empty");
  });

  it("should throw error for whitespace-only string", async () => {
    await expect(embedText("   ")).rejects.toThrow("Text cannot be empty");
  });

  it("should handle API errors gracefully", async () => {
    vi.mocked(embed).mockRejectedValue(new Error("API key invalid"));

    await expect(embedText("test")).rejects.toThrow(
      "Failed to generate embedding: API key invalid",
    );
  });

  it("should handle non-Error exceptions", async () => {
    vi.mocked(embed).mockRejectedValue("Unknown error");

    await expect(embedText("test")).rejects.toThrow(
      "Failed to generate embedding: Unknown error",
    );
  });

  it("should accept text with special characters", async () => {
    const mockEmbedding = createEmbedding(1);
    vi.mocked(embed).mockResolvedValue({
      embedding: mockEmbedding,
      value: "special text",
      usage: { tokens: 3 },
    });

    const result = await embedText("Hello! @#$%^&*() 你好");

    expect(result).toEqual(mockEmbedding);
  });

  it("should accept very long text", async () => {
    const longText = "a".repeat(10000);
    const mockEmbedding = createEmbedding(2);
    vi.mocked(embed).mockResolvedValue({
      embedding: mockEmbedding,
      value: longText,
      usage: { tokens: 1000 },
    });

    const result = await embedText(longText);

    expect(result).toEqual(mockEmbedding);
  });

  it("should throw error when embedding dimension is incorrect", async () => {
    const wrongDimensionEmbedding = createEmbedding(0.1).slice(0, 100);
    vi.mocked(embed).mockResolvedValue({
      embedding: wrongDimensionEmbedding,
      value: "test text",
      usage: { tokens: 2 },
    });

    await expect(embedText("test text")).rejects.toThrow(
      /Embedding dimension mismatch/,
    );
  });
});

describe("embedManyTexts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return array of embedding results for valid texts", async () => {
    const mockEmbeddings = [createEmbedding(0.1), createEmbedding(0.2)];
    const inputTexts = ["text one", "text two"];
    vi.mocked(embedMany).mockResolvedValue({
      embeddings: mockEmbeddings,
      values: inputTexts,
      usage: { tokens: 4 },
    });

    const result = await embedManyTexts(inputTexts);

    expect(result).toEqual([
      { embedding: mockEmbeddings[0], text: "text one" },
      { embedding: mockEmbeddings[1], text: "text two" },
    ]);
    expect(embedMany).toHaveBeenCalledWith({
      model: "mocked-model",
      values: inputTexts,
    });
  });

  it("should throw error for empty array", async () => {
    await expect(embedManyTexts([])).rejects.toThrow(
      "Texts array cannot be empty",
    );
  });

  it("should throw error for array with empty string", async () => {
    await expect(embedManyTexts(["valid", ""])).rejects.toThrow(
      "All texts must be non-empty strings",
    );
  });

  it("should throw error for array with whitespace-only string", async () => {
    await expect(embedManyTexts(["valid", "   "])).rejects.toThrow(
      "All texts must be non-empty strings",
    );
  });

  it("should handle API errors gracefully", async () => {
    vi.mocked(embedMany).mockRejectedValue(new Error("Rate limit exceeded"));

    await expect(embedManyTexts(["test"])).rejects.toThrow(
      "Failed to generate embeddings: Rate limit exceeded",
    );
  });

  it("should throw error when embedding count mismatches input count", async () => {
    vi.mocked(embedMany).mockResolvedValue({
      embeddings: [[0.1, 0.2]],
      values: ["text one"],
      usage: { tokens: 2 },
    });

    await expect(embedManyTexts(["text one", "text two"])).rejects.toThrow(
      "Embedding count mismatch: expected 2, got 1",
    );
  });

  it("should preserve text order in results", async () => {
    const mockEmbeddings = [
      createEmbedding(3),
      createEmbedding(4),
      createEmbedding(5),
    ];
    const orderedTexts = ["first", "second", "third"];
    vi.mocked(embedMany).mockResolvedValue({
      embeddings: mockEmbeddings,
      values: orderedTexts,
      usage: { tokens: 6 },
    });

    const result = await embedManyTexts(orderedTexts);

    expect(result[0].text).toBe("first");
    expect(result[1].text).toBe("second");
    expect(result[2].text).toBe("third");
  });

  it("should handle single text in array", async () => {
    const mockEmbedding = [createEmbedding(6)];
    const singleText = ["single text"];
    vi.mocked(embedMany).mockResolvedValue({
      embeddings: mockEmbedding,
      values: singleText,
      usage: { tokens: 2 },
    });

    const result = await embedManyTexts(["single text"]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      embedding: mockEmbedding[0],
      text: "single text",
    });
  });

  it("should handle large batch of texts", async () => {
    const batchTexts = Array.from({ length: 100 }, (_, i) => `text ${i}`);
    const mockEmbeddings = Array.from({ length: 100 }, (_, i) =>
      createEmbedding(i),
    );
    vi.mocked(embedMany).mockResolvedValue({
      embeddings: mockEmbeddings,
      values: batchTexts,
      usage: { tokens: 200 },
    });

    const result = await embedManyTexts(batchTexts);

    expect(result).toHaveLength(100);
    expect(result[50].text).toBe("text 50");
  });

  it("should throw error when one embedding has incorrect dimension", async () => {
    const validEmbedding = createEmbedding(0.1);
    const wrongDimensionEmbedding = createEmbedding(0.2).slice(0, 100);
    vi.mocked(embedMany).mockResolvedValue({
      embeddings: [validEmbedding, wrongDimensionEmbedding],
      values: ["text one", "text two"],
      usage: { tokens: 4 },
    });

    await expect(embedManyTexts(["text one", "text two"])).rejects.toThrow(
      /Embedding dimension mismatch/,
    );
  });
});
