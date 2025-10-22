import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import type { Stats, Dirent } from "fs";
import path from "path";
import os from "os";
import type { SimpleGit, StatusResult, PullResult } from "simple-git";
import {
  ensureLatest,
  initialize,
  resetInitialization,
  VerifiedScriptsError,
} from "../verifiedScripts.js";

const mockGitInstance = {
  checkIsRepo: vi.fn(),
  status: vi.fn(),
  reset: vi.fn(),
  pull: vi.fn(),
  clone: vi.fn(),
} as unknown as SimpleGit;

vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    promises: {
      stat: vi.fn(),
      mkdir: vi.fn(),
      readdir: vi.fn(),
    },
  };
});

vi.mock("simple-git", () => {
  class GitError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "GitError";
    }
  }

  return {
    simpleGit: vi.fn(() => mockGitInstance),
    GitError,
  };
});

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("verifiedScripts", () => {
  const mockStat = vi.mocked(fs.stat);
  const mockMkdir = vi.mocked(fs.mkdir);
  const mockReaddir = vi.mocked(fs.readdir);
  const mockCheckIsRepo = vi.mocked(mockGitInstance.checkIsRepo);
  const mockStatus = vi.mocked(mockGitInstance.status);
  const mockReset = vi.mocked(mockGitInstance.reset);
  const mockPull = vi.mocked(mockGitInstance.pull);
  const mockClone = vi.mocked(mockGitInstance.clone);
  const testClonePath = path.join(os.tmpdir(), "test-verified-scripts");

  const createMockStats = (isDir: boolean): Stats => ({
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    dev: 0,
    ino: 0,
    mode: 0,
    nlink: 0,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: 0,
    blksize: 0,
    blocks: 0,
    atimeMs: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    birthtimeMs: 0,
    atime: new Date(),
    mtime: new Date(),
    ctime: new Date(),
    birthtime: new Date(),
  });

  const createMockDirent = (name: string, isDir: boolean): Dirent =>
    ({
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      path: "",
      parentPath: "",
    }) as Dirent;

  const createMockPullResult = (
    changes: number,
    files: string[],
  ): PullResult => ({
    files,
    deletions: {},
    insertions: {},
    summary: {
      changes,
      deletions: 0,
      insertions: 0,
    },
    created: [],
    deleted: [],
    remoteMessages: { all: [] },
  });

  const createMockStatusResult = (fileCount: number): StatusResult => ({
    not_added: [],
    conflicted: [],
    created: [],
    deleted: [],
    ignored: undefined,
    modified: [],
    renamed: [],
    files:
      fileCount > 0
        ? [
            {
              path: "modified.ts",
              index: " ",
              working_dir: "M",
              from: "",
            },
          ]
        : [],
    staged: [],
    ahead: 0,
    behind: 0,
    current: "main",
    tracking: "origin/main",
    detached: false,
    isClean: () => fileCount === 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetInitialization();
  });

  afterEach(() => {
    resetInitialization();
  });

  describe("ensureLatest", () => {
    describe("when directory exists", () => {
      beforeEach(() => {
        mockStat.mockResolvedValue(createMockStats(true));
      });

      it("should pull latest changes with no files changed", async () => {
        mockCheckIsRepo.mockResolvedValue(true);
        mockStatus.mockResolvedValue(createMockStatusResult(0));
        mockPull.mockResolvedValue(createMockPullResult(0, []));

        const result = await ensureLatest(testClonePath);

        expect(result.path).toBe(testClonePath);
        expect(result.files).toEqual([]);
        expect(result.isNewClone).toBe(false);
        expect(mockCheckIsRepo).toHaveBeenCalled();
        expect(mockPull).toHaveBeenCalledWith("origin", "main", {
          "--ff-only": null,
        });
      });

      it("should return updated files when pull has changes", async () => {
        mockCheckIsRepo.mockResolvedValue(true);
        mockStatus.mockResolvedValue(createMockStatusResult(0));
        mockPull.mockResolvedValue(
          createMockPullResult(2, ["file1.ts", "file2.ts"]),
        );

        const result = await ensureLatest(testClonePath);

        expect(result.path).toBe(testClonePath);
        expect(result.files).toEqual(["file1.ts", "file2.ts"]);
        expect(result.isNewClone).toBe(false);
      });

      it("should reset local changes before pulling", async () => {
        mockCheckIsRepo.mockResolvedValue(true);
        mockStatus.mockResolvedValue(createMockStatusResult(1));
        mockReset.mockResolvedValue("");
        mockPull.mockResolvedValue(createMockPullResult(0, []));

        await ensureLatest(testClonePath);

        expect(mockReset).toHaveBeenCalledWith(["--hard", "HEAD"]);
        expect(mockPull).toHaveBeenCalled();
      });

      it("should throw error if directory exists but is not a git repo", async () => {
        mockCheckIsRepo.mockResolvedValue(false);

        await expect(ensureLatest(testClonePath)).rejects.toThrow(
          VerifiedScriptsError,
        );
        await expect(ensureLatest(testClonePath)).rejects.toThrow(
          "not a git repository",
        );
      });

      it("should wrap git errors in VerifiedScriptsError", async () => {
        mockCheckIsRepo.mockResolvedValue(true);
        mockStatus.mockResolvedValue(createMockStatusResult(0));

        const { GitError } = (await vi.importMock("simple-git")) as any;
        const gitError = new GitError("network error");
        mockPull.mockRejectedValue(gitError);

        try {
          await ensureLatest(testClonePath);
          expect.fail("Should have thrown an error");
        } catch (error) {
          expect(error).toBeInstanceOf(VerifiedScriptsError);
          expect((error as VerifiedScriptsError).message).toContain(
            "network error",
          );
        }
      });
    });

    describe("when directory does not exist", () => {
      beforeEach(() => {
        const error: NodeJS.ErrnoException = new Error("ENOENT");
        error.code = "ENOENT";
        mockStat.mockRejectedValue(error);
      });

      it("should clone repository and list all files", async () => {
        mockMkdir.mockResolvedValue(undefined);
        mockClone.mockResolvedValue("");
        const mockDirents = [
          createMockDirent("file1.ts", false),
          createMockDirent("file2.ts", false),
          createMockDirent(".git", true),
        ];
        mockReaddir.mockResolvedValue(mockDirents as any);

        const result = await ensureLatest(testClonePath);

        expect(result.path).toBe(testClonePath);
        expect(result.files).toContain("file1.ts");
        expect(result.files).toContain("file2.ts");
        expect(result.files).not.toContain(".git");
        expect(result.isNewClone).toBe(true);
        expect(mockMkdir).toHaveBeenCalledWith(path.dirname(testClonePath), {
          recursive: true,
        });
        expect(mockClone).toHaveBeenCalledWith(
          "https://github.com/elephant-xyz/Counties-trasform-scripts.git",
          testClonePath,
          { "--depth": 1 },
        );
      });

      it("should create parent directories recursively", async () => {
        mockMkdir.mockResolvedValue(undefined);
        mockClone.mockResolvedValue("");
        mockReaddir.mockResolvedValue([]);

        const deepPath = path.join(
          testClonePath,
          "nested",
          "deep",
          "directory",
        );
        await ensureLatest(deepPath);

        expect(mockMkdir).toHaveBeenCalledWith(path.dirname(deepPath), {
          recursive: true,
        });
      });

      it("should handle clone failures", async () => {
        mockMkdir.mockResolvedValue(undefined);

        class GitError extends Error {
          constructor(message: string) {
            super(message);
            this.name = "GitError";
          }
        }
        mockClone.mockRejectedValue(new GitError("authentication failed"));

        await expect(ensureLatest(testClonePath)).rejects.toThrow(
          VerifiedScriptsError,
        );
      });
    });

    describe("path validation", () => {
      it("should reject relative paths", async () => {
        await expect(ensureLatest("./relative/path")).rejects.toThrow(
          VerifiedScriptsError,
        );
        await expect(ensureLatest("./relative/path")).rejects.toThrow(
          "must be absolute",
        );
      });

      it("should use default path when none provided", async () => {
        mockStat.mockResolvedValue(createMockStats(true));

        mockCheckIsRepo.mockResolvedValue(true);
        mockStatus.mockResolvedValue(createMockStatusResult(0));
        mockPull.mockResolvedValue(createMockPullResult(0, []));

        const result = await ensureLatest();

        expect(result.path).toBe(
          path.join(os.homedir(), ".local", "elephant-mcp", "verified-scripts"),
        );
      });

      it("should accept absolute paths", async () => {
        mockStat.mockResolvedValue(createMockStats(true));

        mockCheckIsRepo.mockResolvedValue(true);
        mockStatus.mockResolvedValue(createMockStatusResult(0));
        mockPull.mockResolvedValue(createMockPullResult(0, []));

        const absolutePath = path.join("/", "absolute", "path");
        const result = await ensureLatest(absolutePath);

        expect(result.path).toBe(absolutePath);
      });
    });

    describe("error handling", () => {
      it("should throw VerifiedScriptsError for stat failures", async () => {
        const error = new Error("Permission denied");
        (error as NodeJS.ErrnoException).code = "EACCES";
        mockStat.mockRejectedValue(error);

        await expect(ensureLatest(testClonePath)).rejects.toThrow(
          VerifiedScriptsError,
        );
      });

      it("should propagate VerifiedScriptsError without wrapping", async () => {
        mockStat.mockResolvedValue(createMockStats(true));

        mockCheckIsRepo.mockResolvedValue(false);

        await expect(ensureLatest(testClonePath)).rejects.toThrow(
          VerifiedScriptsError,
        );
      });

      it("should wrap generic errors in VerifiedScriptsError", async () => {
        const error = new Error("Permission denied");
        (error as NodeJS.ErrnoException).code = "EACCES";
        mockStat.mockRejectedValue(error);

        try {
          await ensureLatest(testClonePath);
          expect.fail("Should have thrown an error");
        } catch (e) {
          expect(e).toBeInstanceOf(VerifiedScriptsError);
          expect((e as VerifiedScriptsError).message).toContain(
            "Failed to check directory existence",
          );
        }
      });
    });
  });

  describe("initialize", () => {
    it("should call ensureLatest on first invocation", async () => {
      mockStat.mockResolvedValue(createMockStats(true));

      mockCheckIsRepo.mockResolvedValue(true);
      mockStatus.mockResolvedValue(createMockStatusResult(0));
      mockPull.mockResolvedValue(createMockPullResult(0, []));

      const result = await initialize(testClonePath);

      expect(result.path).toBe(testClonePath);
      expect(mockCheckIsRepo).toHaveBeenCalled();
    });

    it("should return same promise on subsequent calls", async () => {
      resetInitialization();

      mockStat.mockResolvedValue(createMockStats(true));

      mockCheckIsRepo.mockResolvedValue(true);
      mockStatus.mockResolvedValue(createMockStatusResult(0));
      mockPull.mockResolvedValue(createMockPullResult(0, []));

      const promise1 = initialize(testClonePath);
      const promise2 = initialize(testClonePath);

      await Promise.all([promise1, promise2]);

      expect(mockCheckIsRepo).toHaveBeenCalledTimes(1);
    });

    it("should use default path when none provided", async () => {
      mockStat.mockResolvedValue(createMockStats(true));

      mockCheckIsRepo.mockResolvedValue(true);
      mockStatus.mockResolvedValue(createMockStatusResult(0));
      mockPull.mockResolvedValue(createMockPullResult(0, []));

      const result = await initialize();

      expect(result.path).toBe(
        path.join(os.homedir(), ".local", "elephant-mcp", "verified-scripts"),
      );
    });
  });

  describe("resetInitialization", () => {
    it("should allow re-initialization after reset", async () => {
      mockStat.mockResolvedValue(createMockStats(true));

      mockCheckIsRepo.mockResolvedValue(true);
      mockStatus.mockResolvedValue(createMockStatusResult(0));
      mockPull.mockResolvedValue(createMockPullResult(0, []));

      await initialize(testClonePath);

      resetInitialization();

      await initialize(testClonePath);

      expect(mockCheckIsRepo).toHaveBeenCalledTimes(2);
    });

    it("should handle reset before initialization", () => {
      expect(() => resetInitialization()).not.toThrow();
    });
  });

  describe("VerifiedScriptsError", () => {
    it("should create error with message", () => {
      const error = new VerifiedScriptsError("Test error");

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("VerifiedScriptsError");
      expect(error.message).toBe("Test error");
    });

    it("should preserve cause", () => {
      const cause = new Error("Original error");
      const error = new VerifiedScriptsError("Wrapped error", cause);

      expect(error.cause).toBe(cause);
    });
  });
});
