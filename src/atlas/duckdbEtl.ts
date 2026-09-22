import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import os from "node:os";

import {
  escapeAtlasLiteral,
  quoteAtlasIdentifier,
  type AtlasParquetColumn,
} from "./tables.ts";

const CAST_TYPE = {
  text: "VARCHAR",
  boolean: "BOOLEAN",
  int64: "BIGINT",
  double: "DOUBLE",
} as const;

export interface AtlasDuckDb {
  connection: DuckDBConnection;
  close(): void;
}

export async function openAtlasDuckDb(): Promise<AtlasDuckDb> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run(`SET home_directory=${escapeAtlasLiteral(os.tmpdir())}`);
  return {
    connection,
    close() {
      connection.closeSync();
      instance.closeSync();
    },
  };
}

/**
 * Stream Parquet rows with every column cast to its canonical SQL type, so
 * values arrive as string, boolean, bigint, number, or null.
 */
export async function* readAtlasParquet(
  connection: DuckDBConnection,
  files: readonly string[],
  columns: readonly AtlasParquetColumn[],
): AsyncIterable<Record<string, unknown>> {
  if (files.length === 0) return;
  const selected = columns.map(
    (column) =>
      `CAST(${quoteAtlasIdentifier(column.name)} AS ${
        CAST_TYPE[column.canonicalType]
      }) AS ${quoteAtlasIdentifier(column.name)}`,
  );
  const result = await connection.stream(
    `SELECT ${selected.join(", ")}
     FROM read_parquet([${files.map(escapeAtlasLiteral).join(", ")}], union_by_name = true)`,
  );
  const names = result.deduplicatedColumnNames();
  for (;;) {
    const chunk = await result.fetchChunk();
    if (chunk === null || chunk.rowCount === 0) return;
    yield* chunk.getRowObjects(names);
  }
}
