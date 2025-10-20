import { promises as fs } from "fs";
import path from "path";
import Parser, { Query, type QueryMatch, type SyntaxNode } from "tree-sitter";
import JavaScript from "tree-sitter-javascript";

type ExtractedFunction = {
  name: string;
  code: string;
  filePath: string;
};

const querySource = await fs.readFile(
  path.join(__dirname, "..", "..", "queries", "functions.scm"),
);

export async function extractFunctions(
  filePath: string,
): Promise<ExtractedFunction[]> {
  const content = await fs.readFile(filePath, "utf8");
  const parser = new Parser();
  parser.setLanguage(JavaScript as any);
  const tree = parser.parse(content);
  const language = parser.getLanguage();
  const query = new Query(language as any, querySource);
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
    const code = content.slice(declNode.startIndex, declNode.endIndex);
    results.push({ name, code, filePath });
  }
  return results;
}
