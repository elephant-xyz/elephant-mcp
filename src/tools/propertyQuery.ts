import { getAtlasQuerySchema, runAtlasQuery } from "../atlas/query.ts";
import { createTextResult, toolError } from "../lib/utils.ts";

export const DEFAULT_ROW_LIMIT = 100;
export const MAX_ROW_LIMIT = 1000;

export async function queryPropertiesHandler(args: {
  county: string;
  dataGroup: string;
  state: string;
  sql: string;
  limit?: number;
}) {
  try {
    return createTextResult(
      await runAtlasQuery({
        county: args.county,
        dataGroup: args.dataGroup,
        state: args.state,
        sql: args.sql,
        limit: args.limit ?? DEFAULT_ROW_LIMIT,
      }),
    );
  } catch (error) {
    return toolError("Failed to run Atlas property query", error);
  }
}

export async function getPropertyQuerySchemaHandler(args: {
  county: string;
  dataGroup: string;
  state: string;
  table?: string;
}) {
  try {
    return createTextResult(await getAtlasQuerySchema(args));
  } catch (error) {
    return toolError("Failed to fetch Atlas property query schema", error);
  }
}
