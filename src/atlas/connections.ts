import { createClient, type Client, type InValue } from "@libsql/client";
import { drizzle as createLibsqlDrizzle } from "drizzle-orm/libsql";
import { drizzle as createPostgresDrizzle } from "drizzle-orm/postgres-js";
import { sql as drizzleSql } from "drizzle-orm";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { AtlasBackend } from "./backend.ts";

export interface AtlasSqlResult {
  rows: Array<Record<string, unknown>>;
  rowsAffected: number;
}

export interface AtlasExecutor {
  execute(
    statement: string,
    params?: readonly unknown[],
  ): Promise<AtlasSqlResult>;
}

export interface AtlasConnections {
  backend: AtlasBackend["kind"];
  write: AtlasExecutor;
  read(statement: string): Promise<Array<Record<string, unknown>>>;
  transaction<T>(callback: (executor: AtlasExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function libsqlRows(rows: Iterable<Record<string, unknown>>) {
  return Array.from(rows, (row) => ({ ...row }));
}

function libsqlExecutor(client: Pick<Client, "execute">): AtlasExecutor {
  return {
    async execute(statement, params = []) {
      const result = await client.execute({
        sql: statement,
        args: [...params] as InValue[],
      });
      return {
        rows: libsqlRows(
          result.rows as unknown as Iterable<Record<string, unknown>>,
        ),
        rowsAffected: result.rowsAffected,
      };
    },
  };
}

function postgresRows(rows: unknown) {
  return Array.from(rows as Iterable<Record<string, unknown>>, (row) => ({
    ...row,
  }));
}

function postgresPlaceholders(statement: string): string {
  let position = 0;
  return statement.replace(/\?/gu, () => `$${++position}`);
}

function postgresExecutor(client: Sql | TransactionSql): AtlasExecutor {
  return {
    async execute(statement, params = []) {
      const result = await client.unsafe(postgresPlaceholders(statement), [
        ...params,
      ] as never[]);
      return {
        rows: postgresRows(result),
        rowsAffected: result.count,
      };
    },
  };
}

function postgresReadUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const options = url.searchParams.get("options");
  const readOnly = "-c default_transaction_read_only=on";
  url.searchParams.set(
    "options",
    options === null || options.trim() === ""
      ? readOnly
      : `${options} ${readOnly}`,
  );
  return url.toString();
}

async function openSqliteConnections(
  backend: Extract<AtlasBackend, { kind: "sqlite" }>,
): Promise<AtlasConnections> {
  await mkdir(path.dirname(backend.filePath), { recursive: true });
  const writeClient = createClient({ url: backend.databaseUrl });
  const readClient = createClient({ url: backend.databaseUrl });
  await readClient.execute("PRAGMA query_only = ON");
  const readDb = createLibsqlDrizzle(readClient);

  return {
    backend: "sqlite",
    write: libsqlExecutor(writeClient),
    async read(statement) {
      const rows = await readDb.all(drizzleSql.raw(statement));
      return libsqlRows(rows as unknown as Iterable<Record<string, unknown>>);
    },
    async transaction(callback) {
      const transaction = await writeClient.transaction("write");
      try {
        const result = await callback(libsqlExecutor(transaction));
        await transaction.commit();
        return result;
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
    },
    async close() {
      readClient.close();
      writeClient.close();
    },
  };
}

async function openPostgresConnections(
  backend: Extract<AtlasBackend, { kind: "postgres" }>,
): Promise<AtlasConnections> {
  const writeClient = postgres(backend.databaseUrl, {
    max: 1,
    prepare: false,
  });
  const readClient = postgres(postgresReadUrl(backend.databaseUrl), {
    max: 5,
    prepare: false,
  });
  const readDb = createPostgresDrizzle(readClient);

  return {
    backend: "postgres",
    write: postgresExecutor(writeClient),
    async read(statement) {
      const rows = await readDb.execute(drizzleSql.raw(statement));
      return postgresRows(rows);
    },
    transaction: (callback) =>
      writeClient.begin((transaction) =>
        callback(postgresExecutor(transaction)),
      ) as unknown as Promise<Awaited<ReturnType<typeof callback>>>,
    async close() {
      await Promise.all([readClient.end(), writeClient.end()]);
    },
  };
}

export function openAtlasConnections(
  backend: AtlasBackend,
): Promise<AtlasConnections> {
  return backend.kind === "sqlite"
    ? openSqliteConnections(backend)
    : openPostgresConnections(backend);
}
