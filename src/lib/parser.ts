import { promises as fs } from "fs";
import path from "path";
// NOTE: tree-sitter and tree-sitter-javascript are native (node-gyp) addons and
// are declared in optionalDependencies. They may be absent in environments where
// the native build fails (e.g. some CI/Vercel build machines). They are therefore
// lazy-loaded below so importing this module never crashes at load time; the
// code-indexer feature throws a clear, catchable error when they are unavailable.
// Import the query file as raw text using Vite's ?raw suffix
import querySourceRaw from "../queries/functions.scm?raw";

type ExtractedFunction = {
  name: string;
  code: string;
  filePath: string;
};

// Minimal structural types for the tree-sitter API we use, so the rest of this
// module stays typed without a top-level static import of the native module.
type SyntaxNodeLike = {
  text: string;
  startIndex: number;
  endIndex: number;
  hasError: boolean;
};
type QueryMatchLike = {
  captures: { name: string; node: SyntaxNodeLike }[];
};

type TreeSitterModule = {
  Parser: new () => {
    setLanguage(language: unknown): void;
    parse(content: string): { rootNode: SyntaxNodeLike } | null;
    getLanguage(): unknown;
  };
  Query: new (
    language: unknown,
    source: Buffer,
  ) => {
    matches(rootNode: SyntaxNodeLike): QueryMatchLike[];
  };
  JavaScript: unknown;
};

let treeSitterPromise: Promise<TreeSitterModule> | null = null;

/**
 * Lazily load the optional native tree-sitter dependencies. Throws a clear,
 * catchable error if the native modules are not installed/buildable in this
 * environment. Callers (the code indexer) surface this as a feature-unavailable
 * condition rather than crashing the process or the build.
 */
async function loadTreeSitter(): Promise<TreeSitterModule> {
  if (!treeSitterPromise) {
    treeSitterPromise = (async () => {
      try {
        const parserMod = await import("tree-sitter");
        const jsMod = await import("tree-sitter-javascript");
        const Parser = (parserMod.default ??
          parserMod) as TreeSitterModule["Parser"];
        const Query = (parserMod.Query ??
          (parserMod.default as unknown as { Query: unknown })?.Query ??
          (parserMod as unknown as { Query: unknown })
            .Query) as TreeSitterModule["Query"];
        const JavaScript = (jsMod.default ?? jsMod) as unknown;
        return { Parser, Query, JavaScript };
      } catch (error) {
        throw new Error(
          `Code indexer unavailable in this environment: the optional native ` +
            `dependencies "tree-sitter"/"tree-sitter-javascript" are not installed ` +
            `or failed to build. ${
              error instanceof Error ? error.message : String(error)
            }`,
        );
      }
    })();
  }
  return treeSitterPromise;
}

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

  const { Parser, Query, JavaScript } = await loadTreeSitter();

  const parser = new Parser();

  try {
    parser.setLanguage(JavaScript);
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

  let query: InstanceType<TreeSitterModule["Query"]>;
  try {
    query = new Query(language, querySource);
  } catch (error) {
    throw new Error(
      `Failed to create query: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const results: ExtractedFunction[] = [];
  const matches: QueryMatchLike[] = query.matches(tree.rootNode);

  for (const m of matches) {
    let nameNode: SyntaxNodeLike | undefined;
    let declNode: SyntaxNodeLike | undefined;

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
