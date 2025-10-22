import { promises as fs } from "fs";
import path from "path";
import Parser, { Query, type QueryMatch, type SyntaxNode } from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
// Import the query file as raw text using Vite's ?raw suffix
import querySourceRaw from "../queries/functions.scm?raw";

type ExtractedFunction = {
  name: string;
  code: string;
  filePath: string;
};

async function loadQuerySource(): Promise<Buffer> {
  return Buffer.from(querySourceRaw, "utf8");
}

export async function extractFunctions(
  filePath: string,
): Promise<ExtractedFunction[]> {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("Invalid file path: must be a non-empty string");
  }

  const normalizedPath = path.resolve(filePath);

  let content: string;
  try {
    content = await fs.readFile(normalizedPath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read file ${normalizedPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parser = new Parser();

  try {
    parser.setLanguage(JavaScript as any);
  } catch (error) {
    throw new Error(
      `Failed to set JavaScript language: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const tree = parser.parse(content);

  if (!tree || !tree.rootNode) {
    throw new Error(
      `Failed to parse file ${normalizedPath}: invalid syntax tree`,
    );
  }
  if (tree.rootNode.hasError) {
    throw new Error(
      `Failed to parse file ${normalizedPath}: syntax errors present`,
    );
  }

  const language = parser.getLanguage();
  if (!language) {
    throw new Error("Failed to get language from parser");
  }

  const querySource = await loadQuerySource();

  let query: Query;
  try {
    query = new Query(language as any, querySource);
  } catch (error) {
    throw new Error(
      `Failed to create query: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const results: ExtractedFunction[] = [];
  const matches: QueryMatch[] = query.matches(tree.rootNode) as QueryMatch[];

  for (const m of matches) {
    let nameNode: SyntaxNode | undefined;
    let declNode: SyntaxNode | undefined;

    for (const cap of m.captures) {
      if (cap.name === "function.name") nameNode = cap.node;
      if (cap.name === "function.decl") declNode = cap.node;
    }

    if (!nameNode || !declNode) continue;

    const name = nameNode.text;
    if (!name || name.trim() === "") continue;

    const code = content.slice(declNode.startIndex, declNode.endIndex);
    if (!code || code.trim() === "") continue;

    results.push({ name, code, filePath: normalizedPath });
  }

  return results;
}
