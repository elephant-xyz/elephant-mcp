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

interface StrippedStatement {
  literals: string[];
  /** `E'...'`, `U&'...'`, `U&"..."`, `N'...'`, `B'...'`, `X'...'` seen. */
  prefixed: boolean;
  text: string;
}

function stripLiteralsAndComments(statement: string): StrippedStatement {
  const literals: string[] = [];
  let prefixed = false;
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
      const before = statement.slice(Math.max(0, position - 2), position);
      if (
        /^u&$/iu.test(before) ||
        (character === "'" && /(?:^|[^A-Za-z0-9_])[enbx]$/iu.test(before))
      ) {
        prefixed = true;
      }
      if (character === '"') {
        output += character;
        position += 1;
        continue;
      }
      const start = position + 1;
      position += 1;
      while (position < statement.length) {
        if (statement[position] === "'") {
          if (statement[position + 1] === "'") {
            position += 2;
            continue;
          }
          break;
        }
        position += 1;
      }
      literals.push(statement.slice(start, position));
      position += 1;
      output += " ";
      continue;
    }
    output += character;
    position += 1;
  }
  return { literals, prefixed, text: output };
}

export type SelectValidation =
  | { readonly ok: true; readonly sql: string }
  | { readonly ok: false; readonly error: string };

export function validateSelectQuery(sql: string): SelectValidation {
  const trimmed = sql.trim();
  if (trimmed === "") {
    return { ok: false, error: "SQL query must not be empty." };
  }
  const analyzed = stripLiteralsAndComments(trimmed).text;
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

/** Value functions a scoped SELECT may call. Everything else is rejected. */
const FUNCTIONS = new Set(
  `count sum avg min max total group_concat string_agg
   abs round ceil ceiling floor sqrt power pow mod sign exp ln log log10
   lower upper length char_length character_length substr substring trim
   ltrim rtrim replace instr strpos position concat concat_ws left right lpad
   rpad reverse starts_with printf format hex
   date time datetime strftime julianday unixepoch now current_date
   current_timestamp date_trunc date_part extract to_char to_date to_timestamp
   age coalesce nullif ifnull iif typeof greatest least nvl
   json_extract json_valid json_extract_path_text
   row_number rank dense_rank lag lead first_value last_value ntile`
    .split(/\s+/u)
    .filter(Boolean),
);

const OPENS_RELATIONS = new Set(["from", "join"]);
const CLOSES_RELATIONS = new Set([
  "where",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "on",
  "using",
  "union",
  "intersect",
  "except",
  "select",
  "window",
  "fetch",
]);

/**
 * Accept a SELECT whose every identifier is a known relation, one of its
 * columns, an alias the statement itself defines, an allowed function, or a
 * SQL keyword. Quoted identifiers are scanned like bare ones, prefixed and
 * dollar-quoted literals are refused, string literals may not name control
 * tables or catalogs, and an alias may only stand as a qualifier, never as a
 * relation in FROM or JOIN.
 */
export function validateScopedSelect(
  sql: string,
  relations: ReadonlyMap<string, readonly string[]>,
): ScopedSelectValidation {
  const base = validateSelectQuery(sql);
  if (!base.ok) return base;
  const stripped = stripLiteralsAndComments(base.sql);
  if (stripped.prefixed) {
    return {
      ok: false,
      error: "Prefixed literals (E'', U&'', U&\"\") are not supported.",
    };
  }
  if (/\$[A-Za-z_]*\$/u.test(stripped.text)) {
    return { ok: false, error: "Dollar-quoted strings are not supported." };
  }
  const literal = stripped.literals.find((value) =>
    /atlas_|sqlite_|pg_|pragma_|information_schema/iu.test(value),
  );
  if (literal !== undefined) {
    return {
      ok: false,
      error: `String literal '${literal}' names a control table or catalog.`,
    };
  }

  const allowed = new Set(relations.keys());
  for (const columns of relations.values()) {
    for (const column of columns) allowed.add(column);
  }
  const tokens = [...stripped.text.matchAll(TOKEN)].map((match) =>
    match[0].toLowerCase(),
  );
  const isWord = (token: string | undefined) =>
    token !== undefined && /^[a-z_]/u.test(token);
  const words = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => isWord(token));

  const denied = words.find(({ token }) => DENIED_IDENTIFIER.test(token));
  if (denied !== undefined) {
    return {
      ok: false,
      error: `Atlas SQL must not reference '${denied.token}'.`,
    };
  }

  // Whether each token sits in a FROM/JOIN relation list; parentheses
  // restore the enclosing context when they close.
  const inRelations: boolean[] = [];
  const enclosing: boolean[] = [];
  let current = false;
  for (const token of tokens) {
    if (token === "(") enclosing.push(current);
    else if (token === ")") current = enclosing.pop() ?? false;
    else if (OPENS_RELATIONS.has(token)) current = true;
    else if (CLOSES_RELATIONS.has(token)) current = false;
    inRelations.push(current);
  }

  // Aliases may be used before they are defined, so collect them first.
  const ctes = new Set<string>();
  const aliases = new Set<string>();
  const definitions = new Set<number>();
  for (const { token, index } of words) {
    if (
      KEYWORDS.has(token) ||
      allowed.has(token) ||
      tokens[index + 1] === "("
    ) {
      continue;
    }
    const previous = tokens[index - 1];
    if (tokens[index + 1] === "as" && tokens[index + 2] === "(") {
      ctes.add(token);
      definitions.add(index);
    } else if (
      previous === "as" ||
      previous === ")" ||
      (isWord(previous) &&
        !KEYWORDS.has(previous) &&
        (allowed.has(previous) || aliases.has(previous) || ctes.has(previous)))
    ) {
      aliases.add(token);
      definitions.add(index);
    }
  }

  const referenced = new Set<string>();
  for (const { token, index } of words) {
    if (KEYWORDS.has(token)) continue;
    if (tokens[index + 1] === "(") {
      if (FUNCTIONS.has(token)) continue;
      return { ok: false, error: `Function '${token}' is not allowed.` };
    }
    if (relations.has(token)) referenced.add(token);
    if (allowed.has(token) || ctes.has(token)) continue;
    if (aliases.has(token)) {
      const previous = tokens[index - 1];
      if (
        !definitions.has(index) &&
        tokens[index + 1] !== "." &&
        inRelations[index] === true &&
        (previous === "," ||
          previous === "(" ||
          OPENS_RELATIONS.has(previous ?? ""))
      ) {
        return {
          ok: false,
          error: `Alias '${token}' cannot be used as a relation.`,
        };
      }
      continue;
    }
    return {
      ok: false,
      error: `Atlas SQL references unknown identifier '${token}'.`,
    };
  }
  return { ok: true, sql: base.sql, relations: [...referenced] };
}
