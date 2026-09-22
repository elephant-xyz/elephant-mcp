import { getAtlasQuerySchema, runAtlasQuery } from "../atlas/query.ts";
import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";

export const DEFAULT_ROW_LIMIT = 100;
export const MAX_ROW_LIMIT = 1000;

export async function queryPropertiesHandler(args: {
  county: string;
  dataGroup: string;
  table: string;
  sql: string;
  limit?: number;
}) {
  try {
    return createTextResult(
      await runAtlasQuery({
        county: args.county,
        dataGroup: args.dataGroup,
        table: args.table,
        sql: args.sql,
        limit: args.limit ?? DEFAULT_ROW_LIMIT,
      }),
    );
  } catch (error) {
    logger.error(
      {
        county: args.county,
        dataGroup: args.dataGroup,
        error: error instanceof Error ? error.message : String(error),
        table: args.table,
      },
      "queryProperties failed",
    );
    return {
      ...createTextResult({
        error: "Failed to run Atlas property query",
        details: error instanceof Error ? error.message : String(error),
      }),
      isError: true,
    };
  }
}

export async function getPropertyQuerySchemaHandler(args: {
  county: string;
  dataGroup: string;
  table?: string;
}) {
  try {
    return createTextResult(await getAtlasQuerySchema(args));
  } catch (error) {
    logger.error(
      {
        county: args.county,
        dataGroup: args.dataGroup,
        error: error instanceof Error ? error.message : String(error),
        table: args.table,
      },
      "getPropertyQuerySchema failed",
    );
    return {
      ...createTextResult({
        error: "Failed to fetch Atlas property query schema",
        details: error instanceof Error ? error.message : String(error),
      }),
      isError: true,
    };
  }
}
