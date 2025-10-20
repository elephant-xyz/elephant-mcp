import { text, integer, sqliteTable } from "drizzle-orm/sqlite-core";
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
    return sql`vector32(${JSON.stringify(value)})`;
  },
});

export const functionsTable = sqliteTable("functions", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  filePath: text("filePath").notNull(),
});

export const functionEmbeddingsTable = sqliteTable("functionEmbeddings", {
  id: integer("id").primaryKey(),
  functionId: integer("functionId").notNull(),
  chunkIndex: integer("chunkIndex").notNull(),
  embedding: float32Array("vector", { dimensions: 1536 }).notNull(),
});
