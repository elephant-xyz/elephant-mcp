import { text, integer, sqliteTable, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { customType } from "drizzle-orm/sqlite-core";

const float32Array = customType<{
  data: number[];
  config: { dimensions: number };
  configRequired: true;
  driverData: Buffer;
}>({
  dataType(config) {
    return `F32_BLOB(${config.dimensions})`;
  },
  fromDriver(value: Buffer) {
    return Array.from(new Float32Array(value.buffer));
  },
  toDriver(value: number[]) {
    const float32 = new Float32Array(value);
    return Buffer.from(float32.buffer);
  },
});

export const functionsTable = sqliteTable("functions", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  filePath: text("filePath").notNull(),
});

export const functionEmbeddingsTable = sqliteTable(
  "functionEmbeddings",
  {
    id: integer("id").primaryKey(),
    functionId: integer("functionId").notNull(),
    chunkIndex: integer("chunkIndex").notNull(),
    embedding: float32Array("vector", { dimensions: 3072 }).notNull(),
  },
  (table) => ({
    vectorIdx: index("function_embeddings_vector_idx").on(
      sql`libsql_vector_idx(${table.embedding})`,
    ),
  }),
);
