import type { DuckDBConnection } from "@duckdb/node-api";

import { ATLAS_IDENTIFIER_PATTERN } from "./contracts.ts";
import type { AtlasBackend } from "./backend.ts";
import type { AtlasExecutor } from "./connections.ts";

export type AtlasCanonicalType = "text" | "boolean" | "int64" | "double";

export interface AtlasParquetColumn {
  canonicalType: AtlasCanonicalType;
  name: string;
  sourceType: string;
}

export interface AtlasTable {
  columns: AtlasParquetColumn[];
  name: string;
  primaryKey: "cid" | "relationship_cid" | "property_cid";
}

export interface AtlasCatalogColumn {
  name: string;
  type: string;
}

export type AtlasRead = (
  statement: string,
) => Promise<Array<Record<string, unknown>>>;

export function quoteAtlasIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/gu, '""')}"`;
}

export function escapeAtlasLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

/** Content tables live in the backend's default schema next to `atlas_*`. */
export function qualifyAtlasTable(
  backend: AtlasBackend["kind"],
  name: string,
): string {
  return `${backend === "sqlite" ? "main" : "public"}.${quoteAtlasIdentifier(name)}`;
}

function canonicalAtlasType(sourceType: string): AtlasCanonicalType {
  const type = sourceType.trim().toUpperCase();
  if (
    type === "VARCHAR" ||
    type === "TEXT" ||
    type === "STRING" ||
    type === "UUID"
  ) {
    return "text";
  }
  if (type === "BOOLEAN" || type === "BOOL") {
    return "boolean";
  }
  if (
    type === "TINYINT" ||
    type === "SMALLINT" ||
    type === "INTEGER" ||
    type === "INT" ||
    type === "BIGINT" ||
    type === "HUGEINT" ||
    type.startsWith("U")
  ) {
    return "int64";
  }
  if (
    type === "FLOAT" ||
    type === "REAL" ||
    type === "DOUBLE" ||
    type.startsWith("DECIMAL(")
  ) {
    return "double";
  }
  throw new Error(`Unsupported Atlas Parquet type ${sourceType}`);
}

function targetType(
  backend: AtlasBackend["kind"],
  canonicalType: AtlasCanonicalType,
): string {
  if (canonicalType === "text") return "TEXT";
  if (canonicalType === "boolean") return "BOOLEAN";
  if (canonicalType === "int64") return "BIGINT";
  return backend === "postgres" ? "DOUBLE PRECISION" : "REAL";
}

export async function inspectAtlasParquet(
  connection: DuckDBConnection,
  files: readonly string[],
): Promise<AtlasParquetColumn[]> {
  if (files.length === 0) return [];
  const locations = files.map(escapeAtlasLiteral).join(", ");
  const reader = await connection.runAndReadAll(
    `DESCRIBE SELECT * FROM read_parquet([${locations}], union_by_name = true)`,
  );
  return reader.getRowObjectsJson().map((row) => {
    const name = String(row.column_name ?? "");
    const sourceType = String(row.column_type ?? "");
    if (!ATLAS_IDENTIFIER_PATTERN.test(name)) {
      throw new Error(`Invalid Atlas Parquet column identifier ${name}`);
    }
    return {
      canonicalType: canonicalAtlasType(sourceType),
      name,
      sourceType,
    };
  });
}

/**
 * Classify a CountyTables table by its Parquet columns. The `atlas_` prefix is
 * reserved for control and stage tables.
 */
export function describeAtlasTable(
  name: string,
  columns: readonly AtlasParquetColumn[],
): AtlasTable {
  if (!ATLAS_IDENTIFIER_PATTERN.test(name) || name.startsWith("atlas_")) {
    throw new Error(`Invalid Atlas table identifier ${name}`);
  }
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("property_cid")) {
    throw new Error(`Atlas table ${name} must contain property_cid`);
  }
  if (name === "properties") {
    return { columns: [...columns], name, primaryKey: "property_cid" };
  }

  const relationship = names.has("relationship_cid");
  if (relationship === names.has("cid")) {
    throw new Error(
      `Atlas table ${name} must contain exactly one of cid or relationship_cid`,
    );
  }
  if (relationship && (!names.has("from_cid") || !names.has("to_cid"))) {
    throw new Error(
      `Atlas relationship table ${name} must contain from_cid and to_cid`,
    );
  }
  if (!names.has("data_group_cid")) {
    throw new Error(`Atlas table ${name} must contain data_group_cid`);
  }
  return {
    columns: [...columns],
    name,
    primaryKey: relationship ? "relationship_cid" : "cid",
  };
}

/**
 * export-tables writes each entity and relationship CID once per archive, so
 * a row is identified by its scope and its content CID; `property_cid` is the
 * first property that referenced it.
 */
export function atlasKeyColumns(table: AtlasTable): string[] {
  return ["county", "data_group", table.primaryKey];
}

/**
 * Read every non-`atlas_` table and its columns from the database catalog.
 */
export async function readAtlasCatalog(
  read: AtlasRead,
  backend: AtlasBackend["kind"],
): Promise<Map<string, AtlasCatalogColumn[]>> {
  const rows = await read(
    backend === "sqlite"
      ? `SELECT m.name AS table_name, p.name AS column_name, p.type AS column_type
         FROM sqlite_master AS m
         JOIN pragma_table_info(m.name) AS p
         WHERE m.type = 'table' AND m.name NOT LIKE 'atlas\\_%' ESCAPE '\\'
         ORDER BY m.name, p.cid`
      : `SELECT table_name, column_name, data_type AS column_type
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name NOT LIKE 'atlas\\_%' ESCAPE '\\'
         ORDER BY table_name, ordinal_position`,
  );
  const catalog = new Map<string, AtlasCatalogColumn[]>();
  for (const row of rows) {
    const columns = catalog.get(String(row.table_name)) ?? [];
    columns.push({
      name: String(row.column_name),
      type: String(row.column_type).toLowerCase(),
    });
    catalog.set(String(row.table_name), columns);
  }
  return catalog;
}

/**
 * Create the table on first sight and add columns that later archives
 * introduce. A column whose type changes is rejected.
 */
export async function ensureAtlasTable(
  executor: AtlasExecutor,
  backend: AtlasBackend["kind"],
  table: AtlasTable,
): Promise<void> {
  const catalog = await readAtlasCatalog(
    (statement) => executor.execute(statement).then((result) => result.rows),
    backend,
  );
  const existing = catalog.get(table.name);
  if (existing === undefined) {
    const definitions = [
      '"county" TEXT NOT NULL',
      '"data_group" TEXT NOT NULL',
      ...table.columns.map(
        (column) =>
          `${quoteAtlasIdentifier(column.name)} ${targetType(
            backend,
            column.canonicalType,
          )}`,
      ),
      `PRIMARY KEY (${atlasKeyColumns(table)
        .map(quoteAtlasIdentifier)
        .join(", ")})`,
    ];
    await executor.execute(
      `CREATE TABLE ${quoteAtlasIdentifier(table.name)} (${definitions.join(", ")})`,
    );
    return;
  }

  const known = new Map(existing.map((column) => [column.name, column.type]));
  for (const column of table.columns) {
    const type = targetType(backend, column.canonicalType);
    const previous = known.get(column.name);
    if (previous === undefined) {
      await executor.execute(
        `ALTER TABLE ${quoteAtlasIdentifier(
          table.name,
        )} ADD COLUMN ${quoteAtlasIdentifier(column.name)} ${type}`,
      );
    } else if (previous !== type.toLowerCase()) {
      throw new Error(
        `Atlas column ${table.name}.${column.name} changed from ${previous} to ${type.toLowerCase()}`,
      );
    }
  }
}
