import {
  getAtlasProperty,
  getAtlasQuerySchema,
  listAtlasCounties,
  listAtlasProperties,
  resolveAtlasSource,
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
    const [source, schema, published] = await Promise.all([
      resolveAtlasSource(args.state, args.county, args.dataGroup),
      getAtlasQuerySchema(args),
      listAtlasCounties(),
    ]);
    const county = published.counties.find(
      (entry) => entry.county === source.county,
    );
    return createTextResult({
      county: county?.county ?? source.county,
      state: county?.state ?? null,
      fips: county?.fips ?? null,
      tables: schema.tables,
      source,
      syncedAt: published.syncedAt,
    });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "getOracleDatasetInfo failed",
    );
    return toolError("Failed to get Atlas dataset info", error);
  }
}
