import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

vi.mock("../verifiedScripts.js", () => ({ ensureLatest: vi.fn() }));
vi.mock("../parser.js", () => ({ extractFunctions: vi.fn() }));
vi.mock("../embeddings.js", () => ({ embedManyTexts: vi.fn() }));
vi.mock("js-tiktoken", () => ({
    getEncoding: vi.fn(() => {
        // simple stub encoder: 1 token per character
        return {
            encode: (text: string) => Array.from({ length: text.length }, () => 1),
            decode: (tokens: number[]) => "x".repeat(tokens.length),
        } as any;
    }),
}));
vi.mock("../../db/index.js", () => ({
    getFunctionsByFilePath: vi.fn(async () => []),
    deleteFunction: vi.fn(async () => { }),
    saveFunction: vi.fn(async (_db, input) => ({
        id: 1,
        name: input.name,
        code: input.code,
        filePath: input.filePath,
        embeddings: input.embeddings,
    })),
    getIndexState: vi.fn(async () => null),
    setIndexState: vi.fn(async () => undefined),
}));
vi.mock("simple-git", () => ({ default: () => ({ revparse: async () => "deadbeef" }) }));

const { ensureLatest } = await import("../verifiedScripts.js");
const { extractFunctions } = await import("../parser.js");
const { embedManyTexts } = await import("../embeddings.js");
const { saveFunction, getFunctionsByFilePath, deleteFunction, getIndexState, setIndexState } = await import("../../db/index.js");

async function withTempDir(run: (tempRoot: string) => Promise<void>) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vs-indexer-"));
    try {
        await run(tempRoot);
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
}

describe("indexVerifiedScripts", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("indexes JS files on new clone, extracts and saves functions", async () => {
        await withTempDir(async (tempRoot) => {
            const filePath = path.join(tempRoot, "script.mjs");
            await fs.writeFile(filePath, "// placeholder");

            vi.mocked(ensureLatest).mockResolvedValue({ path: tempRoot, files: [], isNewClone: true });
            vi.mocked(extractFunctions).mockResolvedValue([{ name: "hello", code: "function hello(){}", filePath }] as any);
            vi.mocked(embedManyTexts).mockResolvedValue([{ embedding: [0.1, 0.2, 0.3], text: "function hello(){}" }] as any);

            const { indexVerifiedScripts } = await import("../verifiedIndexer.js");
            const summary = await indexVerifiedScripts({} as any, {});

            expect(summary.processedFiles).toContain(filePath);
            expect(summary.savedFunctions).toBe(1);
            expect(saveFunction).toHaveBeenCalledWith(
                {} as any,
                expect.objectContaining({ name: "hello", filePath, embeddings: expect.any(Array) }),
            );
        });
    });

    it("ignores non-JS files", async () => {
        await withTempDir(async (tempRoot) => {
            const md = path.join(tempRoot, "README.md");
            const ts = path.join(tempRoot, "types.ts");
            await fs.writeFile(md, "# docs");
            await fs.writeFile(ts, "export type X = {};");

            vi.mocked(ensureLatest).mockResolvedValue({ path: tempRoot, files: [], isNewClone: true });
            vi.mocked(extractFunctions).mockResolvedValue([] as any);

            const { indexVerifiedScripts } = await import("../verifiedIndexer.js");
            const summary = await indexVerifiedScripts({} as any, {});

            expect(summary.processedFiles.length).toBe(0);
            expect(summary.savedFunctions).toBe(0);
            expect(embedManyTexts).not.toHaveBeenCalled();
        });
    });

    it("uses incremental file list when not fullRescan", async () => {
        await withTempDir(async (tempRoot) => {
            const relJs = path.join("nested", "file.cjs");
            const relTxt = "notes.txt";
            const absJs = path.join(tempRoot, relJs);
            const absTxt = path.join(tempRoot, relTxt);
            await fs.mkdir(path.dirname(absJs), { recursive: true });
            await fs.writeFile(absJs, "// js file");
            await fs.writeFile(absTxt, "ignore");

            vi.mocked(ensureLatest).mockResolvedValue({ path: tempRoot, files: [relJs, relTxt], isNewClone: false });
            vi.mocked(extractFunctions).mockResolvedValue([{ name: "a", code: "function a(){}", filePath: absJs }] as any);
            vi.mocked(embedManyTexts).mockResolvedValue([{ embedding: [1, 2], text: "function a(){}" }] as any);

            const { indexVerifiedScripts } = await import("../verifiedIndexer.js");
            const summary = await indexVerifiedScripts({} as any, {});

            expect(summary.processedFiles).toEqual([absJs]);
            expect(summary.savedFunctions).toBe(1);
        });
    });

    it("rescans all if no changed files but commit differs", async () => {
        await withTempDir(async (tempRoot) => {
            const a = path.join(tempRoot, "a.mjs");
            await fs.writeFile(a, "// a");

            vi.mocked(ensureLatest).mockResolvedValue({ path: tempRoot, files: [], isNewClone: false });
            vi.mocked(getIndexState).mockResolvedValueOnce({ repoPath: tempRoot, lastIndexedCommit: "old", updatedAt: 1 } as any);
            vi.mocked(extractFunctions).mockResolvedValue([{ name: "a", code: "function a(){}", filePath: a }] as any);
            vi.mocked(embedManyTexts).mockResolvedValue([{ embedding: [1], text: "function a(){}" }] as any);

            const { indexVerifiedScripts } = await import("../verifiedIndexer.js");
            const summary = await indexVerifiedScripts({} as any, {});

            expect(summary.processedFiles.sort()).toEqual([a].sort());
            expect(summary.savedFunctions).toBe(1);
            expect(setIndexState).toHaveBeenCalled();
        });
    });

    it("does not rescan if commit matches and no changed files", async () => {
        await withTempDir(async (tempRoot) => {
            // no js files present

            vi.mocked(ensureLatest).mockResolvedValue({ path: tempRoot, files: [], isNewClone: false });
            vi.mocked(getIndexState).mockResolvedValueOnce({ repoPath: tempRoot, lastIndexedCommit: "deadbeef", updatedAt: 1 } as any);

            const { indexVerifiedScripts } = await import("../verifiedIndexer.js");
            const summary = await indexVerifiedScripts({} as any, {});

            expect(summary.processedFiles).toEqual([]);
            expect(summary.savedFunctions).toBe(0);
        });
    });

    it("deletes existing functions before saving new ones", async () => {
        await withTempDir(async (tempRoot) => {
            const filePath = path.join(tempRoot, "script.js");
            await fs.writeFile(filePath, "// x");

            vi.mocked(ensureLatest).mockResolvedValue({ path: tempRoot, files: [], isNewClone: true });
            vi.mocked(getFunctionsByFilePath).mockResolvedValueOnce([
                { id: 123, name: "old", code: "", filePath, embeddings: [] },
            ] as any);
            vi.mocked(extractFunctions).mockResolvedValue([{ name: "n", code: "function n(){}", filePath }] as any);
            vi.mocked(embedManyTexts).mockResolvedValue([{ embedding: [0.4], text: "function n(){}" }] as any);

            const { indexVerifiedScripts } = await import("../verifiedIndexer.js");
            await indexVerifiedScripts({} as any, {});

            expect(deleteFunction).toHaveBeenCalledWith({} as any, 123);
            expect(saveFunction).toHaveBeenCalled();
        });
    });

    it("skips embedding when no functions extracted", async () => {
        await withTempDir(async (tempRoot) => {
            const filePath = path.join(tempRoot, "script.cjs");
            await fs.writeFile(filePath, "// x");

            vi.mocked(ensureLatest).mockResolvedValue({ path: tempRoot, files: [], isNewClone: true });
            vi.mocked(extractFunctions).mockResolvedValue([] as any);

            const { indexVerifiedScripts } = await import("../verifiedIndexer.js");
            const summary = await indexVerifiedScripts({} as any, {});

            expect(summary.savedFunctions).toBe(0);
            expect(embedManyTexts).not.toHaveBeenCalled();
        });
    });

    it("continues indexing other files on error", async () => {
        await withTempDir(async (tempRoot) => {
            const a = path.join(tempRoot, "a.js");
            const b = path.join(tempRoot, "b.js");
            await fs.writeFile(a, "// a");
            await fs.writeFile(b, "// b");

            vi.mocked(ensureLatest).mockResolvedValue({ path: tempRoot, files: [], isNewClone: true });
            vi.mocked(extractFunctions).mockImplementation(async (fp: string) => {
                if (fp.endsWith("a.js")) throw new Error("parse error");
                return [{ name: "b", code: "function b(){}", filePath: b }] as any;
            });
            vi.mocked(embedManyTexts).mockResolvedValue([{ embedding: [9], text: "function b(){}" }] as any);

            const { indexVerifiedScripts } = await import("../verifiedIndexer.js");
            const summary = await indexVerifiedScripts({} as any, { fullRescan: true, clonePath: tempRoot });

            expect(summary.processedFiles.sort()).toEqual([a, b].sort());
            expect(summary.savedFunctions).toBe(1);
        });
    });

    it("splits long function into multiple chunks and saves all embeddings", async () => {
        await withTempDir(async (tempRoot) => {
            const filePath = path.join(tempRoot, "big.js");
            await fs.writeFile(filePath, "// big");

            const longCode = "X".repeat(9000); // 9000 tokens with our stub encoder

            vi.mocked(ensureLatest).mockResolvedValue({ path: tempRoot, files: [], isNewClone: true });
            vi.mocked(extractFunctions).mockResolvedValue([{ name: "bigFn", code: longCode, filePath }] as any);
            vi.mocked(embedManyTexts).mockImplementation(async (chunks: string[]) =>
                chunks.map((c, i) => ({ embedding: [i], text: c })) as any,
            );

            const { indexVerifiedScripts } = await import("../verifiedIndexer.js");
            const summary = await indexVerifiedScripts({} as any, {});

            expect(summary.savedFunctions).toBe(1);

            const { saveFunction } = await import("../../db/index.js");
            expect(saveFunction).toHaveBeenCalledWith(
                {} as any,
                expect.objectContaining({
                    name: "bigFn",
                    filePath,
                    // 9000 tokens -> 2 chunks of ~4500 each (<=8192)
                    embeddings: expect.arrayContaining([[0], [1]]),
                }),
            );
        });
    });
});
