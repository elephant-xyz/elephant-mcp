import { listAtlasCounties } from "../atlas/query.ts";
import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";

/**
 * Enumerate every county/group in the last accepted Atlas SQL snapshot.
 */
export async function listPublishedCountiesHandler(_options?: unknown) {
  try {
    return createTextResult(await listAtlasCounties());
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "listPublishedCounties failed",
    );
    return {
      ...createTextResult({
        error: "Failed to read synchronized Atlas counties",
        details: error instanceof Error ? error.message : String(error),
      }),
      isError: true,
    };
  }
}
