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

/** libsql rows are array-like column holders; copy them to plain objects. */
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
      };
    },
  };
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
      return { rows: [...(result as Iterable<Record<string, unknown>>)] };
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
  // WAL lets reads keep serving the accepted snapshot while a sync commits;
  // busy_timeout covers the brief checkpoint and commit locks.
  for (const client of [writeClient, readClient]) {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA busy_timeout = 5000");
  }
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
  // int8 (BIGINT, count(*)) is returned as bigint rather than a string.
  const types = { bigint: postgres.BigInt };
  const writeClient = postgres(backend.databaseUrl, {
    max: 1,
    prepare: false,
    types,
  });
  const readClient = postgres(postgresReadUrl(backend.databaseUrl), {
    max: 5,
    prepare: false,
    types,
  });
  const readDb = createPostgresDrizzle(readClient);

  return {
    backend: "postgres",
    write: postgresExecutor(writeClient),
    async read(statement) {
      const rows = await readDb.execute(drizzleSql.raw(statement));
      return [...(rows as Iterable<Record<string, unknown>>)];
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
