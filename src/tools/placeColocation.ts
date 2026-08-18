import {
  runPlaceColocationAnalysis,
  type PlaceColocationRequest,
} from "../lib/placeColocation.ts";
import {
  runPlaceColocationDiscovery,
  type PlaceColocationDiscoveryRequest,
} from "../lib/placeColocationDiscovery.ts";
import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";

/** Execute one bounded, deterministic occupied-cell co-location analysis. */
export async function analyzePlaceColocationHandler(
  args: PlaceColocationRequest,
  options: { readonly signal?: AbortSignal } = {},
) {
  try {
    return createTextResult(
      await runPlaceColocationAnalysis(args, {
        abortSignal: options.signal,
      }),
    );
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        county: args.county,
        categoryA: args.categoryA,
        categoryB: args.categoryB,
      },
      "analyzePlaceColocation failed",
    );
    return {
      ...createTextResult({
        error: "Failed to analyze published place co-location",
        details: error instanceof Error ? error.message : String(error),
      }),
      isError: true,
    };
  }
}

/** Discover one bounded, deterministic family of co-location candidates. */
export async function discoverPlaceColocationCandidatesHandler(
  args: PlaceColocationDiscoveryRequest,
  options: { readonly signal?: AbortSignal } = {},
) {
  try {
    return createTextResult(
      await runPlaceColocationDiscovery(args, {
        abortSignal: options.signal,
      }),
    );
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        county: args.county,
      },
      "discoverPlaceColocationCandidates failed",
    );
    return {
      ...createTextResult({
        error: "Failed to discover published place co-location candidates",
        details: error instanceof Error ? error.message : String(error),
      }),
      isError: true,
    };
  }
}
