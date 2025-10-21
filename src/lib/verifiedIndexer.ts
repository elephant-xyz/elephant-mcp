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
} from "../db/index.js";
import type { IndexerOptions, IndexSummary } from "../types/entities.js";

const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

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
    return files.filter((f) => JS_EXTENSIONS.has(path.extname(f)));
}

export async function indexVerifiedScripts(
    db: LibSQLDatabase,
    opts: IndexerOptions = {},
): Promise<IndexSummary> {
    const { clonePath, fullRescan } = opts;

    const repo = await ensureLatest(clonePath);

    let targetFiles: string[];
    if (fullRescan || repo.isNewClone) {
        const all = await listFilesRecursively(repo.path);
        targetFiles = filterJsFiles(all);
    } else {
        // repo.files are relative to repo.path
        const candidate = repo.files.map((rel) => path.join(repo.path, rel));
        targetFiles = filterJsFiles(candidate);
    }

    logger.info(
        { count: targetFiles.length, root: repo.path },
        "Indexing verified scripts",
    );

    let savedFunctions = 0;

    for (const filePath of targetFiles) {
        try {
            // Clean previous entries for the file
            const existing = await getFunctionsByFilePath(db as any, path.resolve(filePath));
            for (const func of existing) {
                await deleteFunction(db as any, func.id);
            }

            // Extract functions
            const functions = await extractFunctions(filePath);
            if (functions.length === 0) {
                continue;
            }

            // Batch-embed all function codes from this file to reduce API calls
            const embeddings = await embedManyTexts(functions.map((f) => f.code));

            for (let i = 0; i < functions.length; i++) {
                const fn = functions[i];
                const emb = embeddings[i]?.embedding;
                if (!emb) continue;
                await saveFunction(db as any, {
                    name: fn.name,
                    code: fn.code,
                    filePath: fn.filePath, // already absolute per parser
                    embeddings: [emb],
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

    return { processedFiles: targetFiles, savedFunctions };
}


