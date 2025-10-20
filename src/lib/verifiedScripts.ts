import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { simpleGit, GitError } from "simple-git";
import { logger } from "../logger.js";

const VERIFIED_SCRIPTS_REPO =
  "https://github.com/elephant-xyz/Counties-trasform-scripts.git";
const DEFAULT_CLONE_PATH = path.join(
  os.homedir(),
  ".local",
  "elephant-mcp",
  "verified-scripts",
);

export class VerifiedScriptsError extends Error {
  constructor(
    message: string,
    public cause?: Error,
  ) {
    super(message);
    this.name = "VerifiedScriptsError";
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dir);
    return stats.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new VerifiedScriptsError(
      `Failed to check directory existence: ${dir}`,
      error as Error,
    );
  }
}

export interface EnsureLatestResult {
  path: string;
  files: string[];
  isNewClone: boolean;
}

async function listAllFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentPath: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === ".git") continue;

      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(dir, fullPath);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        files.push(relativePath);
      }
    }
  }

  await walk(dir);
  return files.sort();
}

export async function ensureLatest(
  clonePath?: string,
): Promise<EnsureLatestResult> {
  const targetPath = clonePath ?? DEFAULT_CLONE_PATH;

  if (!path.isAbsolute(targetPath)) {
    throw new VerifiedScriptsError(
      `Clone path must be absolute: ${targetPath}`,
    );
  }

  try {
    const exists = await dirExists(targetPath);
    let files: string[] = [];
    let isNewClone = false;

    if (exists) {
      logger.info({ path: targetPath }, "Updating verified scripts repository");
      const git = simpleGit(targetPath);

      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        throw new VerifiedScriptsError(
          `Directory exists but is not a git repository: ${targetPath}`,
        );
      }

      const status = await git.status();
      if (status.files.length > 0) {
        logger.warn(
          { path: targetPath, files: status.files.length },
          "Local changes detected, resetting before pull",
        );
        await git.reset(["--hard", "HEAD"]);
      }

      const pullResult = await git.pull("origin", "main", {
        "--ff-only": null,
      });

      if (pullResult.summary.changes > 0 && pullResult.files) {
        files = pullResult.files;
      }

      logger.info(
        { path: targetPath, changes: pullResult.summary.changes },
        "Successfully updated repository",
      );
    } else {
      logger.info({ path: targetPath }, "Cloning verified scripts repository");

      const parentDir = path.dirname(targetPath);
      await fs.mkdir(parentDir, { recursive: true });

      const git = simpleGit();
      await git.clone(VERIFIED_SCRIPTS_REPO, targetPath, {
        "--depth": 1,
      });
      logger.info({ path: targetPath }, "Successfully cloned repository");
      isNewClone = true;

      files = await listAllFiles(targetPath);
    }

    return {
      path: targetPath,
      files,
      isNewClone,
    };
  } catch (error) {
    if (error instanceof VerifiedScriptsError) {
      throw error;
    }

    if (error instanceof GitError) {
      throw new VerifiedScriptsError(
        `Git operation failed: ${error.message}`,
        error,
      );
    }

    throw new VerifiedScriptsError(
      `Failed to ensure verified scripts: ${error instanceof Error ? error.message : String(error)}`,
      error as Error,
    );
  }
}

let initializationPromise: Promise<EnsureLatestResult> | null = null;

export async function initialize(
  clonePath?: string,
): Promise<EnsureLatestResult> {
  if (!initializationPromise) {
    initializationPromise = ensureLatest(clonePath);
  }
  return initializationPromise;
}

export function resetInitialization(): void {
  initializationPromise = null;
}
