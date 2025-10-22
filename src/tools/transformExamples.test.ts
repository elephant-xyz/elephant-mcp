import { describe, it, expect, beforeEach, vi } from "vitest";
import * as embeddings from "../lib/embeddings.ts";
import * as connectionRef from "../db/connectionRef.ts";
import * as repository from "../db/repository.ts";
import * as config from "../config.ts";

vi.mock("../lib/embeddings.ts");
vi.mock("../db/connectionRef.ts");
vi.mock("../db/repository.ts");
vi.mock("../config.ts");
vi.mock("../logger.ts", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { transformExamplesHandler } from "./transformExamples.ts";

describe("transformExamplesHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validation", () => {
    it("should return error when OPENAI_API_KEY is missing", async () => {
      vi.mocked(config.getConfig).mockReturnValue({
        NODE_ENV: "test",
        OPENAI_API_KEY: "",
        LOG_LEVEL: "info",
      });

      const result = await transformExamplesHandler("test query");

      expect(result.content[0]?.text).toContain("Missing OPENAI_API_KEY");
    });

    it("should return error when text is empty", async () => {
      vi.mocked(config.getConfig).mockReturnValue({
        NODE_ENV: "test",
        OPENAI_API_KEY: "test-key",
        LOG_LEVEL: "info",
      });

      const result = await transformExamplesHandler("");

      expect(result.content[0]?.text).toContain("Text cannot be empty");
    });

    it("should return error when text is whitespace only", async () => {
      vi.mocked(config.getConfig).mockReturnValue({
        NODE_ENV: "test",
        OPENAI_API_KEY: "test-key",
        LOG_LEVEL: "info",
      });

      const result = await transformExamplesHandler("   ");

      expect(result.content[0]?.text).toContain("Text cannot be empty");
    });

    it("should return error when database is not initialized", async () => {
      vi.mocked(config.getConfig).mockReturnValue({
        NODE_ENV: "test",
        OPENAI_API_KEY: "test-key",
        LOG_LEVEL: "info",
      });
      vi.mocked(connectionRef.getDbInstance).mockReturnValue(undefined);

      const result = await transformExamplesHandler("test query");

      expect(result.content[0]?.text).toContain("Database is not initialized");
    });
  });

  describe("successful search", () => {
    const mockDb = {} as ReturnType<typeof connectionRef.getDbInstance>;
    const mockEmbedding = Array.from({ length: 1536 }, (_, i) => i / 1536);

    beforeEach(() => {
      vi.mocked(config.getConfig).mockReturnValue({
        NODE_ENV: "test",
        OPENAI_API_KEY: "test-key",
        LOG_LEVEL: "info",
      });
      vi.mocked(connectionRef.getDbInstance).mockReturnValue(mockDb);
      vi.mocked(embeddings.embedText).mockResolvedValue(mockEmbedding);
    });

    it("should return search results with default topK", async () => {
      const mockResults = [
        {
          functionWithChunks: {
            id: 1,
            name: "testFunction1",
            code: "function test1() {}",
            filePath: "/src/test1.ts",
            embeddings: [mockEmbedding],
          },
          distance: 0.1,
        },
        {
          functionWithChunks: {
            id: 2,
            name: "testFunction2",
            code: "function test2() {}",
            filePath: "/src/test2.ts",
            embeddings: [mockEmbedding],
          },
          distance: 0.2,
        },
      ];

      vi.mocked(repository.searchSimilar).mockResolvedValue(mockResults);

      const result = await transformExamplesHandler("test query");

      expect(embeddings.embedText).toHaveBeenCalledWith("test query");
      expect(repository.searchSimilar).toHaveBeenCalledWith(
        mockDb,
        mockEmbedding,
        5,
      );
      expect(result.content[0]?.text).toContain('"count": 2');
      expect(result.content[0]?.text).toContain("testFunction1");
      expect(result.content[0]?.text).toContain("testFunction2");
      expect(result.content[0]?.text).toContain("function test1() {}");
      expect(result.content[0]?.text).toContain("function test2() {}");
    });

    it("should use custom topK value", async () => {
      vi.mocked(repository.searchSimilar).mockResolvedValue([]);

      await transformExamplesHandler("test query", 10);

      expect(repository.searchSimilar).toHaveBeenCalledWith(
        mockDb,
        mockEmbedding,
        10,
      );
    });

    it("should clamp topK to minimum of 1", async () => {
      vi.mocked(repository.searchSimilar).mockResolvedValue([]);

      await transformExamplesHandler("test query", 0);

      expect(repository.searchSimilar).toHaveBeenCalledWith(
        mockDb,
        mockEmbedding,
        1,
      );
    });

    it("should clamp topK to maximum of 50", async () => {
      vi.mocked(repository.searchSimilar).mockResolvedValue([]);

      await transformExamplesHandler("test query", 100);

      expect(repository.searchSimilar).toHaveBeenCalledWith(
        mockDb,
        mockEmbedding,
        50,
      );
    });

    it("should handle negative topK values", async () => {
      vi.mocked(repository.searchSimilar).mockResolvedValue([]);

      await transformExamplesHandler("test query", -5);

      expect(repository.searchSimilar).toHaveBeenCalledWith(
        mockDb,
        mockEmbedding,
        1,
      );
    });

    it("should return empty matches when no results found", async () => {
      vi.mocked(repository.searchSimilar).mockResolvedValue([]);

      const result = await transformExamplesHandler("test query");

      expect(result.content[0]?.text).toContain('"count": 0');
      expect(result.content[0]?.text).toContain('"matches": []');
    });
  });

  describe("error handling", () => {
    const mockDb = {} as ReturnType<typeof connectionRef.getDbInstance>;
    const mockEmbedding = Array.from({ length: 1536 }, (_, i) => i / 1536);

    beforeEach(() => {
      vi.mocked(config.getConfig).mockReturnValue({
        NODE_ENV: "test",
        OPENAI_API_KEY: "test-key",
        LOG_LEVEL: "info",
      });
      vi.mocked(connectionRef.getDbInstance).mockReturnValue(mockDb);
    });

    it("should handle embedText errors", async () => {
      vi.mocked(embeddings.embedText).mockRejectedValue(new Error("API error"));

      const result = await transformExamplesHandler("test query");

      expect(result.content[0]?.text).toContain("Failed to transform examples");
    });

    it("should handle searchSimilar errors", async () => {
      vi.mocked(embeddings.embedText).mockResolvedValue(mockEmbedding);
      vi.mocked(repository.searchSimilar).mockRejectedValue(
        new Error("Database error"),
      );

      const result = await transformExamplesHandler("test query");

      expect(result.content[0]?.text).toContain("Failed to transform examples");
    });

    it("should handle non-Error exceptions", async () => {
      vi.mocked(embeddings.embedText).mockRejectedValue("string error");

      const result = await transformExamplesHandler("test query");

      expect(result.content[0]?.text).toContain("Failed to transform examples");
    });
  });
});
