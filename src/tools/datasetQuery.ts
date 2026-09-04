import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";
import {
  executeDatasetQueryPlan,
  getDatasetQueryCapabilities,
  type DatasetQueryPlan,
} from "../lib/datasetQuery.ts";

export async function getDatasetQueryCapabilitiesHandler(
  args: { county: string },
  options: { signal?: AbortSignal } = {},
) {
  try {
    return createTextResult(
      await getDatasetQueryCapabilities(args.county, options.signal),
    );
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        county: args.county,
      },
      "getDatasetQueryCapabilities failed",
    );
    return createTextResult({
      error: "Failed to describe dataset query capabilities",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function executeDatasetQueryPlanHandler(
  args: { plan: DatasetQueryPlan },
  options: { signal?: AbortSignal } = {},
) {
  try {
    return createTextResult(
      await executeDatasetQueryPlan(args.plan, options.signal),
    );
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        county: args.plan.county,
        dataset: args.plan.dataset,
      },
      "executeDatasetQueryPlan failed",
    );
    return createTextResult({
      error: "Failed to execute dataset query plan",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
