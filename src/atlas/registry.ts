import type { DuckDBConnection } from "@duckdb/node-api";

import { TABLE_IDENTIFIER_PATTERN } from "./contracts.ts";
import type { AtlasBackend } from "./backend.ts";
import type { AtlasExecutor } from "./connections.ts";

export type AtlasCanonicalType = "text" | "boolean" | "int64" | "double";
export type AtlasContentKind = "entity" | "relationship";

export interface AtlasParquetColumn {
  canonicalType: AtlasCanonicalType;
  name: string;
  sourceType: string;
}

export interface AtlasContentTable {
  columns: AtlasParquetColumn[];
  kind: AtlasContentKind;
  logicalName: string;
  physicalName: string;
  primaryKey: "cid" | "relationship_cid";
}

const CONTEXT_COLUMNS = new Set(["property_cid", "data_group_cid"]);
const COLUMN_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

export function quoteAtlasIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/gu, '""')}"`;
}

export function escapeAtlasLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

export function canonicalAtlasType(sourceType: string): AtlasCanonicalType {
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
    if (!COLUMN_IDENTIFIER_PATTERN.test(name)) {
      throw new Error(`Invalid Atlas Parquet column identifier ${name}`);
    }
    return {
      canonicalType: canonicalAtlasType(sourceType),
      name,
      sourceType,
    };
  });
}

export function describeAtlasContentTable(
  logicalName: string,
  columns: readonly AtlasParquetColumn[],
): AtlasContentTable | null {
  if (!TABLE_IDENTIFIER_PATTERN.test(logicalName)) {
    throw new Error(`Invalid Atlas table identifier ${logicalName}`);
  }
  if (logicalName === "properties") return null;
  const names = new Set(columns.map((column) => column.name));
  const relationship = names.has("relationship_cid");
  const entity = names.has("cid");

  if (relationship === entity) {
    throw new Error(
      `Atlas table ${logicalName} must contain exactly one of cid or relationship_cid`,
    );
  }
  if (relationship && (!names.has("from_cid") || !names.has("to_cid"))) {
    throw new Error(
      `Atlas relationship table ${logicalName} must contain from_cid and to_cid`,
    );
  }
  if (!names.has("property_cid") || !names.has("data_group_cid")) {
    throw new Error(
      `Atlas table ${logicalName} must contain property_cid and data_group_cid`,
    );
  }

  return {
    columns: columns.filter((column) => !CONTEXT_COLUMNS.has(column.name)),
    kind: relationship ? "relationship" : "entity",
    logicalName,
    physicalName: `atlas_content__${logicalName}`,
    primaryKey: relationship ? "relationship_cid" : "cid",
  };
}

export async function ensureAtlasContentTable(
  executor: AtlasExecutor,
  backend: AtlasBackend["kind"],
  table: AtlasContentTable,
  indexCid: string,
): Promise<string[]> {
  const registered = await executor.execute(
    `SELECT table_kind, primary_key_column, physical_table_name
     FROM atlas_table_registry
     WHERE table_name = ?`,
    [table.logicalName],
  );
  const existing = registered.rows[0];
  if (
    existing !== undefined &&
    (existing.table_kind !== table.kind ||
      existing.primary_key_column !== table.primaryKey ||
      existing.physical_table_name !== table.physicalName)
  ) {
    throw new Error(
      `Atlas table ${table.logicalName} conflicts with its registered shape`,
    );
  }

  const knownResult = await executor.execute(
    `SELECT column_name, canonical_type
     FROM atlas_column_registry
     WHERE table_name = ?`,
    [table.logicalName],
  );
  const known = new Map(
    knownResult.rows.map((row) => [
      String(row.column_name),
      String(row.canonical_type),
    ]),
  );
  for (const column of table.columns) {
    const previous = known.get(column.name);
    if (previous !== undefined && previous !== column.canonicalType) {
      throw new Error(
        `Atlas column ${table.logicalName}.${column.name} changed from ${previous} to ${column.canonicalType}`,
      );
    }
  }

  if (existing === undefined) {
    const definitions = table.columns.map(
      (column) =>
        `${quoteAtlasIdentifier(column.name)} ${targetType(
          backend,
          column.canonicalType,
        )}${column.name === table.primaryKey ? " PRIMARY KEY" : ""}`,
    );
    await executor.execute(
      `CREATE TABLE ${quoteAtlasIdentifier(table.physicalName)} (${definitions.join(", ")})`,
    );
    await executor.execute(
      `INSERT INTO atlas_table_registry (
        table_name,
        physical_table_name,
        table_kind,
        primary_key_column,
        created_index_cid
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        table.logicalName,
        table.physicalName,
        table.kind,
        table.primaryKey,
        indexCid,
      ],
    );
  }

  const added: string[] = [];
  for (const column of table.columns) {
    if (known.has(column.name)) continue;
    if (existing !== undefined) {
      await executor.execute(
        `ALTER TABLE ${quoteAtlasIdentifier(
          table.physicalName,
        )} ADD COLUMN ${quoteAtlasIdentifier(column.name)} ${targetType(
          backend,
          column.canonicalType,
        )}`,
      );
    }
    await executor.execute(
      `INSERT INTO atlas_column_registry (
        table_name,
        column_name,
        canonical_type,
        first_index_cid
      ) VALUES (?, ?, ?, ?)`,
      [table.logicalName, column.name, column.canonicalType, indexCid],
    );
    added.push(column.name);
  }
  return added;
}
