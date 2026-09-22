import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import os from "node:os";

import type { AtlasBackend } from "./backend.ts";
import { escapeAtlasLiteral, quoteAtlasIdentifier } from "./registry.ts";

const TARGET_CATALOG = "atlas_target";

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

export async function attachAtlasTarget(
  connection: DuckDBConnection,
  backend: AtlasBackend,
): Promise<"main" | "public"> {
  if (backend.kind === "sqlite") {
    await connection.run("INSTALL sqlite");
    await connection.run("LOAD sqlite");
    await connection.run(
      `ATTACH ${escapeAtlasLiteral(
        backend.filePath,
      )} AS ${TARGET_CATALOG} (TYPE SQLITE)`,
    );
    return "main";
  }

  await connection.run("INSTALL postgres");
  await connection.run("LOAD postgres");
  await connection.run(
    `ATTACH ${escapeAtlasLiteral(
      backend.databaseUrl,
    )} AS ${TARGET_CATALOG} (TYPE POSTGRES)`,
  );
  return "public";
}

export async function detachAtlasTarget(
  connection: DuckDBConnection,
): Promise<void> {
  await connection.run(`DETACH ${TARGET_CATALOG}`);
}

export async function stageAtlasParquet(args: {
  connection: DuckDBConnection;
  files: readonly string[];
  stageTable: string;
  targetSchema: "main" | "public";
}): Promise<number> {
  if (args.files.length === 0) return 0;
  const locations = args.files.map(escapeAtlasLiteral).join(", ");
  const target = `${TARGET_CATALOG}.${args.targetSchema}.${quoteAtlasIdentifier(args.stageTable)}`;
  await args.connection.run(`DROP TABLE IF EXISTS ${target}`);
  await args.connection.run(
    `CREATE TABLE ${target} AS
     SELECT *
     FROM read_parquet([${locations}], union_by_name = true)`,
  );
  const result = await args.connection.runAndReadAll(
    `SELECT count(*) AS count FROM ${target}`,
  );
  const row = result.getRowObjectsJson()[0];
  return Number(row?.count ?? 0);
}

export async function dropAtlasStage(
  connection: DuckDBConnection,
  stageTable: string,
  targetSchema: "main" | "public" = "main",
): Promise<void> {
  await connection.run(
    `DROP TABLE IF EXISTS ${TARGET_CATALOG}.${targetSchema}.${quoteAtlasIdentifier(stageTable)}`,
  );
}
