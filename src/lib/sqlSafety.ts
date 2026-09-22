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

/**
 * Words a read-only SELECT may contain besides relation names, column names,
 * aliases, and function calls. Anything else is an unknown identifier.
 */
const KEYWORDS = new Set(
  `select from where and or not as on join left right inner outer full cross
   natural using group by order having limit offset distinct all asc desc null
   is in between like ilike glob regexp match escape case when then else end
   cast exists union intersect except with recursive true false nulls first
   last over partition rows range groups unbounded preceding following current
   row window filter within collate nocase binary rtrim any some similar to
   isnull notnull lateral values fetch next only ties both leading trailing at
   zone symmetric array interval date time timestamp timestamptz integer int
   bigint smallint text varchar char real double precision float numeric
   decimal boolean bool year month day hour minute second epoch dow doy week
   quarter`
    .split(/\s+/u)
    .filter(Boolean),
);

/** Control tables, catalogs, and schema qualifiers are never addressable. */
const DENIED_IDENTIFIER =
  /^(?:atlas_|sqlite_|pg_|pragma_)|^(?:information_schema|main|temp|public)$/u;

const TOKEN = /(?<![0-9A-Za-z_])[A-Za-z_][A-Za-z0-9_]*|[().,]/gu;

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
    if (character === "'") {
      position += 1;
      while (position < statement.length) {
        if (statement[position] === "'") {
          if (statement[position + 1] === "'") {
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

export type ScopedSelectValidation =
  | { readonly ok: true; readonly sql: string; readonly relations: string[] }
  | { readonly ok: false; readonly error: string };

/**
 * Accept a SELECT whose every identifier is a known relation, one of its
 * columns, an alias the statement itself defines, a function call, or a SQL
 * keyword. Quoted identifiers are scanned like bare ones, so no spelling of a
 * control table, catalog, or schema qualifier gets through.
 */
export function validateScopedSelect(
  sql: string,
  relations: ReadonlyMap<string, readonly string[]>,
): ScopedSelectValidation {
  const base = validateSelectQuery(sql);
  if (!base.ok) return base;

  const allowed = new Set(relations.keys());
  for (const columns of relations.values()) {
    for (const column of columns) allowed.add(column);
  }
  const tokens = [...stripLiteralsAndComments(base.sql).matchAll(TOKEN)].map(
    (match) => match[0].toLowerCase(),
  );
  const words = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => /^[a-z_]/u.test(token));
  const isFunction = ({ index }: { index: number }) =>
    tokens[index + 1] === "(";

  // Aliases may be used before they are defined, so collect them first.
  const aliases = new Set<string>();
  for (const word of words) {
    const { token, index } = word;
    if (KEYWORDS.has(token) || allowed.has(token) || isFunction(word)) continue;
    const previous = tokens[index - 1];
    if (
      previous === "as" ||
      previous === ")" ||
      (tokens[index + 1] === "as" && tokens[index + 2] === "(") ||
      (previous !== undefined &&
        /^[a-z_]/u.test(previous) &&
        !KEYWORDS.has(previous) &&
        (allowed.has(previous) || aliases.has(previous)))
    ) {
      aliases.add(token);
    }
  }

  const denied = words.find(({ token }) => DENIED_IDENTIFIER.test(token));
  if (denied !== undefined) {
    return {
      ok: false,
      error: `Atlas SQL must not reference '${denied.token}'.`,
    };
  }

  const referenced = new Set<string>();
  for (const word of words) {
    const { token } = word;
    if (relations.has(token)) referenced.add(token);
    if (
      KEYWORDS.has(token) ||
      allowed.has(token) ||
      aliases.has(token) ||
      isFunction(word)
    ) {
      continue;
    }
    return {
      ok: false,
      error: `Atlas SQL references unknown identifier '${token}'.`,
    };
  }
  return { ok: true, sql: base.sql, relations: [...referenced] };
}
