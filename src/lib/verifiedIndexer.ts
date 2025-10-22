import path from "path";
import { promises as fs } from "fs";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { logger } from "../logger.js";
import { ensureLatest } from "./verifiedScripts.js";
import { extractFunctions } from "./parser.js";
import { embedManyTexts } from "./embeddings.js";
import {
  getFunctionsByFilePath,
  deleteFunction,
  saveFunction,
  getIndexState,
  setIndexState,
} from "../db/index.js";
import type { IndexerOptions, IndexSummary } from "../types/entities.js";
import simpleGit from "simple-git";
import { getEncoding } from "js-tiktoken";

const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);

const MAX_TOKENS_PER_CHUNK = 8192;

type TokenEncoder = {
  encode: (text: string) => number[];
  decode: (tokens: number[]) => string;
};

function splitByTokens(
  enc: TokenEncoder,
  text: string,
  maxTokensPerChunk: number,
): string[] {
  const tokens = enc.encode(text);
  if (tokens.length === 0) return [];

  let chunksCount = 1;
  while (Math.ceil(tokens.length / chunksCount) > maxTokensPerChunk) {
    chunksCount *= 2;
  }

  const chunkSize = Math.ceil(tokens.length / chunksCount);
  const chunks: string[] = [];
  for (let i = 0; i < tokens.length; i += chunkSize) {
    const slice = tokens.slice(i, i + chunkSize);
    const chunkText = enc.decode(slice);
    if (chunkText.trim().length > 0) {
      chunks.push(chunkText);
    }
  }

  return chunks;
}

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursively(fullPath)));
    } else {
      results.push(fullPath);
    }
  }

  return results;
}

function filterJsFiles(files: string[]): string[] {
  return files.filter((f) => {
    const ext = path.extname(f);
    return JS_EXTENSIONS.has(ext);
  });
}

export async function indexVerifiedScripts(
  db: LibSQLDatabase,
  opts: IndexerOptions = {},
): Promise<IndexSummary> {
  const { clonePath, fullRescan } = opts;

  const repo = await ensureLatest(clonePath);

  // Resolve current HEAD commit of the verified repo
  const git = simpleGit(repo.path);
  const headCommit = (await git.revparse(["HEAD"])).trim();

  let targetFiles: string[];

  if (fullRescan || repo.isNewClone) {
    const all = await listFilesRecursively(repo.path);
    targetFiles = filterJsFiles(all);
  } else {
    // repo.files are relative to repo.path
    const candidate = repo.files.map((rel) => path.join(repo.path, rel));
    targetFiles = filterJsFiles(candidate);

    // If pull had no changed files, decide based on commit state
    if (targetFiles.length === 0) {
      const state = await getIndexState(db, repo.path);
      if (!state || state.lastIndexedCommit !== headCommit) {
        const all = await listFilesRecursively(repo.path);
        targetFiles = filterJsFiles(all);
      }
    }
  }

  logger.info(
    { count: targetFiles.length, root: repo.path },
    "Indexing verified scripts",
  );

  let savedFunctions = 0;

  const enc: TokenEncoder = getEncoding("cl100k_base");
  for (const filePath of targetFiles) {
    try {
      // Clean previous entries for the file
      const existing = await getFunctionsByFilePath(db, path.resolve(filePath));
      for (const func of existing) {
        await deleteFunction(db, func.id);
      }

      // Extract functions
      const functions = await extractFunctions(filePath);
      if (functions.length === 0) {
        continue;
      }

      // For each function, split into token-bounded equal parts and embed per function
      for (const fn of functions) {
        const chunks = splitByTokens(enc, fn.code, MAX_TOKENS_PER_CHUNK);
        if (chunks.length === 0) continue;

        logger.debug(
          { filePath: fn.filePath, function: fn.name, chunks: chunks.length },
          "Embedding function in chunks",
        );

        const results = await embedManyTexts(chunks);
        const embeddings = results
          .map((r) => r?.embedding)
          .filter((e): e is number[] => Array.isArray(e) && e.length > 0);
        if (embeddings.length === 0) continue;

        await saveFunction(db, {
          name: fn.name,
          code: fn.code,
          filePath: fn.filePath, // already absolute per parser
          embeddings,
        });
        savedFunctions += 1;
      }
    } catch (error) {
      logger.error(
        {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to index file",
      );
      // continue with other files
    }
  }

  // Update last indexed commit only if we actually saved something
  if (savedFunctions > 0) {
    try {
      await setIndexState(db, repo.path, headCommit);
    } catch (err) {
      logger.warn(
        {
          path: repo.path,
          commit: headCommit,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to update index state",
      );
    }
  }

  return { processedFiles: targetFiles, savedFunctions };
}
