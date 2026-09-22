import { listAtlasCounties } from "../atlas/query.ts";
import { createTextResult, toolError } from "../lib/utils.ts";

/**
 * Enumerate every county/group in the last accepted Atlas SQL snapshot.
 */
export async function listPublishedCountiesHandler(_options?: unknown) {
  try {
    return createTextResult(await listAtlasCounties());
  } catch (error) {
    return toolError("Failed to read synchronized Atlas counties", error);
  }
}
