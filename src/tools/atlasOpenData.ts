import {
  getAtlasProperty,
  getAtlasQuerySchema,
  listAtlasProperties,
} from "../atlas/query.ts";
import { createTextResult, toolError } from "../lib/utils.ts";

export async function listOraclePropertiesHandler(args: {
  county: string;
  dataGroup: string;
  state: string;
  limit?: number;
  offset?: number;
}) {
  try {
    return createTextResult(
      await listAtlasProperties({
        county: args.county,
        dataGroup: args.dataGroup,
        state: args.state,
        limit: args.limit ?? 50,
        offset: args.offset ?? 0,
      }),
    );
  } catch (error) {
    return toolError("Failed to list Atlas properties", error);
  }
}

export async function getOraclePropertyHandler(args: {
  county: string;
  dataGroup: string;
  state: string;
  propertyCid: string;
}) {
  try {
    return createTextResult(await getAtlasProperty(args));
  } catch (error) {
    return toolError("Failed to get Atlas property", error);
  }
}

export async function getOracleDatasetInfoHandler(args: {
  county: string;
  dataGroup: string;
  state: string;
}) {
  try {
    const { source, tables } = await getAtlasQuerySchema(args);
    return createTextResult({
      county: source.county,
      state: source.state,
      fips: source.fips,
      tables,
      source,
      syncedAt: source.syncedAt,
    });
  } catch (error) {
    return toolError("Failed to get Atlas dataset info", error);
  }
}
