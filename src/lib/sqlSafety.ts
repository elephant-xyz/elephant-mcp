const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "UPSERT",
  "CREATE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "REPLACE",
  "ATTACH",
  "DETACH",
  "COPY",
  "EXPORT",
  "IMPORT",
  "INSTALL",
  "LOAD",
  "PRAGMA",
  "CALL",
  "SET",
  "RESET",
  "VACUUM",
  "CHECKPOINT",
  "USE",
] as const;

const READ_ONLY_LEADING_KEYWORDS = new Set(["SELECT", "WITH"]);

function stripLiteralsAndComments(statement: string): string {
  let output = "";
  let position = 0;

  while (position < statement.length) {
    const character = statement[position];
    const next = statement[position + 1];
    if (character === "-" && next === "-") {
      position += 2;
      while (position < statement.length && statement[position] !== "\n") {
        position += 1;
      }
      output += " ";
      continue;
    }
    if (character === "/" && next === "*") {
      position += 2;
      while (
        position < statement.length &&
        !(statement[position] === "*" && statement[position + 1] === "/")
      ) {
        position += 1;
      }
      position += 2;
      output += " ";
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      position += 1;
      while (position < statement.length) {
        if (statement[position] === quote) {
          if (statement[position + 1] === quote) {
            position += 2;
            continue;
          }
          position += 1;
          break;
        }
        position += 1;
      }
      output += " ";
      continue;
    }
    output += character;
    position += 1;
  }
  return output;
}

export type SelectValidation =
  | { readonly ok: true; readonly sql: string }
  | { readonly ok: false; readonly error: string };

export function validateSelectQuery(sql: string): SelectValidation {
  const trimmed = sql.trim();
  if (trimmed === "") {
    return { ok: false, error: "SQL query must not be empty." };
  }
  const analyzed = stripLiteralsAndComments(trimmed);
  const withoutTrailing = analyzed.replace(/;\s*$/u, "");
  if (withoutTrailing.includes(";")) {
    return {
      ok: false,
      error:
        "Only a single SELECT statement is allowed — multiple statements are rejected.",
    };
  }
  const leading = withoutTrailing
    .trimStart()
    .split(/[\s(]/u, 1)[0]
    ?.toUpperCase();
  if (!leading || !READ_ONLY_LEADING_KEYWORDS.has(leading)) {
    return {
      ok: false,
      error:
        "Only read-only SELECT queries are allowed (the statement must begin with SELECT or WITH).",
    };
  }
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, "iu").test(withoutTrailing)) {
      return {
        ok: false,
        error: `Disallowed keyword '${keyword}' — only read-only SELECT queries are permitted.`,
      };
    }
  }
  return { ok: true, sql: trimmed.replace(/;\s*$/u, "") };
}
