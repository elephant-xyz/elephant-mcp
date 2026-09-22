import {
  getAtlasProperty,
  getAtlasQuerySchema,
  listAtlasProperties,
} from "../atlas/query.ts";
import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";

function toolError(message: string, error: unknown) {
  return {
    ...createTextResult({
      error: message,
      details: error instanceof Error ? error.message : String(error),
    }),
    isError: true,
  };
}

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
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "listOracleProperties failed",
    );
    return toolError("Failed to list Atlas properties", error);
  }
}

export async function getOraclePropertyHandler(args: {
  county: string;
  dataGroup: string;
  state: string;
  propertyCid?: string;
  cid?: string;
}) {
  const propertyCid = args.propertyCid ?? args.cid;
  if (propertyCid === undefined) {
    return toolError(
      "Failed to get Atlas property",
      new Error("Provide exactly one of propertyCid or cid"),
    );
  }
  if (args.propertyCid !== undefined && args.cid !== undefined) {
    return toolError(
      "Failed to get Atlas property",
      new Error("Provide exactly one of propertyCid or cid"),
    );
  }
  try {
    return createTextResult(
      await getAtlasProperty({
        county: args.county,
        dataGroup: args.dataGroup,
        state: args.state,
        propertyCid,
      }),
    );
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "getOracleProperty failed",
    );
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
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "getOracleDatasetInfo failed",
    );
    return toolError("Failed to get Atlas dataset info", error);
  }
}
