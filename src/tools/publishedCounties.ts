import { createHash } from "node:crypto";

import { fetchPublishedCountyCatalog } from "../lib/publishedCountyCatalog.ts";
import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";

/**
 * Enumerate every Oracle county whose public data artifacts have been
 * published and entered in the canonical Oracle-owned catalog.
 */
export async function listPublishedCountiesHandler() {
  try {
    const catalog = await fetchPublishedCountyCatalog();
    const catalogRevision = createHash("sha256")
      .update(JSON.stringify(catalog))
      .digest("hex");
    return createTextResult({
      schemaVersion: catalog.schemaVersion,
      generatedAt: catalog.generatedAt,
      catalogRevision,
      countyCount: catalog.counties.length,
      counties: catalog.counties,
    });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "listPublishedCounties failed",
    );
    return {
      ...createTextResult({
        error: "Failed to read the canonical published-county catalog",
        details: error instanceof Error ? error.message : String(error),
      }),
      isError: true,
    };
  }
}
