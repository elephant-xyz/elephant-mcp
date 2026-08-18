import { createHash } from "node:crypto";

import type { DuckDBConnection, DuckDBValue, Json } from "@duckdb/node-api";

import { getEmbeddingProvider, type EmbeddingProvider } from "../config.ts";
import {
  embedManyTexts,
  getActiveEmbeddingModel,
  type EmbeddingCallOptions,
  type EmbeddingResult,
} from "./embeddings.ts";
import {
  resolveCatalogPlacesTableProvenance,
  type ImmutablePlacesTableProvenance,
} from "./immutablePlacesProvenance.ts";
import {
  PLACES_VIEW,
  buildPlacePredicate,
  getPlaceProvenance,
  readPlaceRows,
  resolvePublishedPlacesDataset,
  withPlaceConnection,
  type PlaceFilters,
  type PlaceProvenance,
} from "./placeQuery.ts";

export const DEFAULT_GRID_CELL_SIZE_METERS = 800 as const;
export const ALLOWED_GRID_CELL_SIZES_METERS = [400, 800, 1600] as const;
export const COLOCATION_PERMUTATIONS = 199 as const;
export const MAX_COLOCATION_PLACES = 100_000 as const;
export const MAX_COLOCATION_CELLS = 20_000 as const;
export const GRID_FORMULA_VERSION = "equirectangular-global-origin-v1" as const;
export const NULL_MODEL_VERSION = "macro-8x8-density-log2-sha256-v1" as const;
export const TAXONOMY_DISTANCE_VERSION =
  "taxonomy-longest-common-prefix-v1" as const;
export const SEMANTIC_DISTANCE_VERSION = "glossed-embedding-cosine-v1" as const;
export const SEMANTIC_GLOSS_VERSION =
  "category-label-hierarchy-gloss-v1" as const;
export const SEMANTIC_EMBEDDING_TIMEOUT_MS = 15_000 as const;
export const VECTOR_HASH_ENCODING =
  "SHA-256 over concatenated finite IEEE-754 binary64 big-endian values in vector index order, with -0 normalized to +0 and no delimiter" as const;

const METERS_PER_LATITUDE_DEGREE = 111_320;
const GLOBAL_ORIGIN_LATITUDE = -90;
const GLOBAL_ORIGIN_LONGITUDE = -180;
const POLAR_COSINE_FLOOR = 1e-6;

export type GridCellSizeMeters =
  (typeof ALLOWED_GRID_CELL_SIZES_METERS)[number];
export type HostedServiceMode = "include" | "exclude" | "only";

export interface PlaceColocationRequest {
  readonly county: string;
  readonly categoryA: string;
  readonly categoryB: string;
  readonly gridCellSizeMeters?: GridCellSizeMeters;
  readonly hostedService?: HostedServiceMode;
  readonly operatingStatus?: string;
  readonly minConfidence?: number;
}

export interface PlaceColocationEmbeddingRuntime {
  readonly available: boolean;
  readonly provider: EmbeddingProvider;
  readonly model: string;
  readonly embedMany: (
    texts: string[],
    options?: EmbeddingCallOptions,
  ) => Promise<EmbeddingResult[]>;
}

export interface PlaceColocationRuntimeOptions {
  readonly embedding?: PlaceColocationEmbeddingRuntime;
  readonly abortSignal?: AbortSignal;
}

export interface GridDefinition {
  readonly cellSizeMeters: GridCellSizeMeters;
  readonly referenceLatitude: number;
  readonly latitudeStepDegrees: number;
  readonly longitudeStepDegrees: number;
  readonly originLatitude: -90;
  readonly originLongitude: -180;
  readonly formula: string;
  readonly version: typeof GRID_FORMULA_VERSION;
}

export interface GridCellEvidence {
  readonly cellId: string;
  readonly latitudeIndex: number;
  readonly longitudeIndex: number;
  readonly density: number;
  readonly hasCategoryA: boolean;
  readonly hasCategoryB: boolean;
}

export interface ModalPathEvidence {
  readonly path: string | null;
  readonly supportCount: number;
  readonly coverage: number | null;
  readonly ambiguityCount: number;
}

export interface NullModelEvidence {
  readonly description: string;
  readonly version: typeof NULL_MODEL_VERSION;
  readonly permutations: typeof COLOCATION_PERMUTATIONS;
  readonly meanExpectedJointCells: number;
  readonly standardDeviationJointCells: number;
  readonly pValue: number | null;
  readonly densityConditionedLift: number | null;
  readonly permutableStratumCount: number;
  readonly fixedStratumCount: number;
  readonly noPermutationReason: string | null;
  readonly seed: string;
}

export interface PlaceColocationEvidence {
  readonly county: {
    readonly key: string;
    readonly name: string;
    readonly stateCode: string;
    readonly fips: string;
  };
  readonly inputs: {
    readonly county: string;
    readonly categoryA: string;
    readonly categoryB: string;
    readonly gridCellSizeMeters: GridCellSizeMeters;
    readonly hostedService: HostedServiceMode;
    readonly operatingStatus: string | null;
    readonly minConfidence: number | null;
  };
  readonly universe: {
    readonly unit: "occupied fixed grid cells";
    readonly totalFilteredPlaces: number;
    readonly validCoordinatePlaces: number;
    readonly coordinateCoverage: number;
    readonly occupiedCells: number;
  };
  readonly grid: GridDefinition;
  readonly categories: {
    readonly a: CategoryEvidence;
    readonly b: CategoryEvidence;
  };
  readonly observed: {
    readonly cellsWithCategoryA: number;
    readonly cellsWithCategoryB: number;
    readonly jointCells: number;
    readonly independenceExpectedJointCells: number | null;
    readonly globalLift: number | null;
    readonly independenceExpectedFormula: string;
    readonly globalLiftFormula: string;
  };
  readonly densityConditionedNull: NullModelEvidence;
  readonly taxonomyDistance: {
    readonly value: number | null;
    readonly formula: string;
    readonly version: typeof TAXONOMY_DISTANCE_VERSION;
  };
  readonly semanticDistance: {
    readonly value: number | null;
    readonly reason: string | null;
    readonly formula: string;
    readonly version: typeof SEMANTIC_DISTANCE_VERSION;
    readonly provider: EmbeddingProvider;
    readonly model: string;
    readonly glossVersion: typeof SEMANTIC_GLOSS_VERSION;
    readonly glossInputs: {
      readonly categoryA: string | null;
      readonly categoryB: string | null;
    };
    readonly vectorHashes: {
      readonly encoding: typeof VECTOR_HASH_ENCODING;
      readonly categoryA: string | null;
      readonly categoryB: string | null;
    };
    readonly dimensions: number | null;
    readonly timeoutMilliseconds: typeof SEMANTIC_EMBEDDING_TIMEOUT_MS;
  };
  readonly semanticCalibration: {
    readonly empiricalPercentile: null;
    readonly reason: string;
    readonly discoverySourceRequiredForClassH: true;
  };
  readonly provenance: PlaceProvenance & {
    readonly releaseIdentity: string;
  };
  readonly method: {
    readonly grid: typeof GRID_FORMULA_VERSION;
    readonly nullModel: typeof NULL_MODEL_VERSION;
    readonly taxonomyDistance: typeof TAXONOMY_DISTANCE_VERSION;
    readonly semanticDistance: typeof SEMANTIC_DISTANCE_VERSION;
  };
  readonly rerunContract: string;
  readonly decisionNote: string;
}

interface CategoryEvidence {
  readonly id: string;
  readonly label: string;
  readonly totalPlaces: number;
  readonly coordinatePlaces: number;
  readonly coordinateCoverage: number | null;
  readonly hierarchy: ModalPathEvidence;
}

interface PreflightSummary {
  readonly totalFilteredPlaces: number;
  readonly validCoordinatePlaces: number;
  readonly categoryATotalPlaces: number;
  readonly categoryACoordinatePlaces: number;
  readonly categoryBTotalPlaces: number;
  readonly categoryBCoordinatePlaces: number;
  readonly minLatitude: number;
  readonly maxLatitude: number;
  readonly minLongitude: number;
  readonly maxLongitude: number;
  readonly minimumRelease: string | null;
  readonly maximumRelease: string | null;
  readonly distinctReleaseCount: number;
  readonly nullReleaseCount: number;
}

interface ModalPathRow {
  readonly categoryId: string;
  readonly path: string;
  readonly supportCount: number;
  readonly ambiguityCount: number;
}

interface Stratum {
  readonly id: string;
  readonly cells: readonly GridCellEvidence[];
  readonly categoryBCellCount: number;
  readonly categoryACellCount: number;
  readonly overlapCanVary: boolean;
}

const VALID_COORDINATE_SQL = [
  "latitude IS NOT NULL",
  "longitude IS NOT NULL",
  "isfinite(latitude)",
  "isfinite(longitude)",
  "latitude BETWEEN -90 AND 90",
  "longitude BETWEEN -180 AND 180",
].join(" AND ");

/**
 * Canonicalize an unordered category pair. The first category is always the
 * fixed category in the conditional randomization test.
 */
export function canonicalizeCategoryPair(
  categoryA: string,
  categoryB: string,
): readonly [string, string] {
  const left = categoryA.trim();
  const right = categoryB.trim();
  if (left === right) {
    throw new Error("categoryA and categoryB must be distinct.");
  }
  return left < right ? [left, right] : [right, left];
}

/**
 * Construct deterministic equirectangular degree steps from a county's stable
 * latitude midpoint.
 */
export function computeGridDefinition(
  cellSizeMeters: GridCellSizeMeters,
  minimumLatitude: number,
  maximumLatitude: number,
): GridDefinition {
  const referenceLatitude = (minimumLatitude + maximumLatitude) / 2;
  const cosine = Math.cos((referenceLatitude * Math.PI) / 180);
  if (
    !Number.isFinite(referenceLatitude) ||
    referenceLatitude < -90 ||
    referenceLatitude > 90 ||
    !Number.isFinite(cosine) ||
    Math.abs(cosine) <= POLAR_COSINE_FLOOR
  ) {
    throw new Error(
      "Cannot construct the co-location grid from polar or degenerate latitude bounds.",
    );
  }
  const latitudeStepDegrees = cellSizeMeters / METERS_PER_LATITUDE_DEGREE;
  const longitudeStepDegrees =
    cellSizeMeters / (METERS_PER_LATITUDE_DEGREE * cosine);
  if (
    !Number.isFinite(latitudeStepDegrees) ||
    latitudeStepDegrees <= 0 ||
    !Number.isFinite(longitudeStepDegrees) ||
    longitudeStepDegrees <= 0
  ) {
    throw new Error(
      "Cannot construct the co-location grid from polar or degenerate latitude bounds.",
    );
  }
  return {
    cellSizeMeters,
    referenceLatitude,
    latitudeStepDegrees,
    longitudeStepDegrees,
    originLatitude: GLOBAL_ORIGIN_LATITUDE,
    originLongitude: GLOBAL_ORIGIN_LONGITUDE,
    formula:
      "latStep=cellSize/111320; lonStep=cellSize/(111320*cos(referenceLatitude)); latIndex=floor((latitude+90)/latStep); lonIndex=floor((longitude+180)/lonStep)",
    version: GRID_FORMULA_VERSION,
  };
}

/** Assign one coordinate to the fixed-global-origin grid. */
export function assignGridCell(
  latitude: number,
  longitude: number,
  grid: GridDefinition,
): { readonly latitudeIndex: number; readonly longitudeIndex: number } {
  return {
    latitudeIndex: Math.floor(
      (latitude - grid.originLatitude) / grid.latitudeStepDegrees,
    ),
    longitudeIndex: Math.floor(
      (longitude - grid.originLongitude) / grid.longitudeStepDegrees,
    ),
  };
}

/**
 * Select the modal hierarchy path. Tied modes are resolved lexicographically,
 * and ambiguityCount records how many additional paths shared modal support.
 */
export function selectModalHierarchyPath(
  pathCounts: readonly {
    readonly path: string;
    readonly supportCount: number;
  }[],
  coordinateCategoryCount: number,
): ModalPathEvidence {
  const sorted = [...pathCounts].sort(
    (left, right) =>
      right.supportCount - left.supportCount ||
      left.path.localeCompare(right.path),
  );
  const selected = sorted[0];
  if (selected === undefined) {
    return {
      path: null,
      supportCount: 0,
      coverage: coordinateCategoryCount === 0 ? null : 0,
      ambiguityCount: 0,
    };
  }
  return {
    path: selected.path,
    supportCount: selected.supportCount,
    coverage:
      coordinateCategoryCount === 0
        ? null
        : selected.supportCount / coordinateCategoryCount,
    ambiguityCount:
      sorted.filter(
        (candidate) => candidate.supportCount === selected.supportCount,
      ).length - 1,
  };
}

/** Compute normalized taxonomy-tree distance from slash-delimited paths. */
export function computeTaxonomyTreeDistance(
  pathA: string | null,
  pathB: string | null,
): number | null {
  if (pathA === null || pathB === null) return null;
  const segmentsA = pathA.split("/").filter((segment) => segment.length > 0);
  const segmentsB = pathB.split("/").filter((segment) => segment.length > 0);
  if (segmentsA.length === 0 || segmentsB.length === 0) return null;
  let longestCommonPrefixSegments = 0;
  const comparableDepth = Math.min(segmentsA.length, segmentsB.length);
  while (
    longestCommonPrefixSegments < comparableDepth &&
    segmentsA[longestCommonPrefixSegments] ===
      segmentsB[longestCommonPrefixSegments]
  ) {
    longestCommonPrefixSegments += 1;
  }
  return (
    1 -
    (2 * longestCommonPrefixSegments) / (segmentsA.length + segmentsB.length)
  );
}

/** Build the exact canonical text embedded for one category. */
export function buildCategorySemanticGloss(
  categoryId: string,
  hierarchyPath: string | null,
): string | null {
  if (hierarchyPath === null) return null;
  return `Overture category label: ${categoryLabel(categoryId)}. Full taxonomy hierarchy: ${hierarchyPath}.`;
}

/**
 * Hash one embedding using a documented, architecture-independent encoding.
 */
export function hashEmbeddingVector(vector: readonly number[]): string {
  const bytes = Buffer.alloc(vector.length * 8);
  vector.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      throw new Error("Embedding vector contains a non-finite value.");
    }
    bytes.writeDoubleBE(Object.is(value, -0) ? 0 : value, index * 8);
  });
  return createHash("sha256").update(bytes).digest("hex");
}

/** Compute clamped cosine distance for two finite, non-zero vectors. */
export function computeEmbeddingCosineDistance(
  vectorA: readonly number[],
  vectorB: readonly number[],
): number {
  if (vectorA.length === 0 || vectorA.length !== vectorB.length) {
    throw new Error(
      "Embedding vectors must be non-empty and have equal dimensions.",
    );
  }
  let scaleA = 0;
  let scaleB = 0;
  for (let index = 0; index < vectorA.length; index += 1) {
    const valueA = vectorA[index];
    const valueB = vectorB[index];
    if (
      valueA === undefined ||
      valueB === undefined ||
      !Number.isFinite(valueA) ||
      !Number.isFinite(valueB)
    ) {
      throw new Error("Embedding vectors must contain only finite values.");
    }
    scaleA = Math.max(scaleA, Math.abs(valueA));
    scaleB = Math.max(scaleB, Math.abs(valueB));
  }
  if (scaleA === 0 || scaleB === 0) {
    throw new Error("Embedding vectors must have non-zero magnitude.");
  }

  // Scaling each vector by its largest component preserves cosine similarity
  // while preventing finite provider values from overflowing or underflowing
  // during dot-product and squared-magnitude accumulation.
  let scaledDotProduct = 0;
  let scaledMagnitudeASquared = 0;
  let scaledMagnitudeBSquared = 0;
  for (let index = 0; index < vectorA.length; index += 1) {
    const scaledA = vectorA[index]! / scaleA;
    const scaledB = vectorB[index]! / scaleB;
    scaledDotProduct += scaledA * scaledB;
    scaledMagnitudeASquared += scaledA * scaledA;
    scaledMagnitudeBSquared += scaledB * scaledB;
  }
  const cosineSimilarity =
    scaledDotProduct /
    Math.sqrt(scaledMagnitudeASquared * scaledMagnitudeBSquared);
  if (!Number.isFinite(cosineSimilarity)) {
    throw new Error("Embedding cosine similarity is non-finite.");
  }
  return Math.max(0, Math.min(1, 1 - cosineSimilarity));
}

interface SemanticDistanceEvidence {
  readonly value: number | null;
  readonly reason: string | null;
  readonly formula: string;
  readonly version: typeof SEMANTIC_DISTANCE_VERSION;
  readonly provider: EmbeddingProvider;
  readonly model: string;
  readonly glossVersion: typeof SEMANTIC_GLOSS_VERSION;
  readonly glossInputs: {
    readonly categoryA: string | null;
    readonly categoryB: string | null;
  };
  readonly vectorHashes: {
    readonly encoding: typeof VECTOR_HASH_ENCODING;
    readonly categoryA: string | null;
    readonly categoryB: string | null;
  };
  readonly dimensions: number | null;
  readonly timeoutMilliseconds: typeof SEMANTIC_EMBEDDING_TIMEOUT_MS;
}

function boundedSemanticReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/\s+/g, " ").trim();
  return normalized.length <= 240
    ? normalized
    : `${normalized.slice(0, 237)}...`;
}

/**
 * Embed two canonical category glosses with a provider-aborting timeout.
 *
 * The AI SDK forwards AbortSignal to both supported embedding providers, so no
 * detached Promise.race or unobserved provider promise is created.
 */
export async function computeGlossedSemanticDistance(
  categoryA: { readonly id: string; readonly hierarchyPath: string | null },
  categoryB: { readonly id: string; readonly hierarchyPath: string | null },
  runtime: PlaceColocationEmbeddingRuntime,
  abortSignal?: AbortSignal,
): Promise<SemanticDistanceEvidence> {
  const glossA = buildCategorySemanticGloss(
    categoryA.id,
    categoryA.hierarchyPath,
  );
  const glossB = buildCategorySemanticGloss(
    categoryB.id,
    categoryB.hierarchyPath,
  );
  const base = {
    formula: "clamp(1 - cosineSimilarity(vectorA, vectorB), 0, 1)",
    version: SEMANTIC_DISTANCE_VERSION,
    provider: runtime.provider,
    model: runtime.model,
    glossVersion: SEMANTIC_GLOSS_VERSION,
    glossInputs: { categoryA: glossA, categoryB: glossB },
    timeoutMilliseconds: SEMANTIC_EMBEDDING_TIMEOUT_MS,
  } as const;
  const unavailable = (reason: string): SemanticDistanceEvidence => ({
    ...base,
    value: null,
    reason: boundedSemanticReason(reason),
    vectorHashes: {
      encoding: VECTOR_HASH_ENCODING,
      categoryA: null,
      categoryB: null,
    },
    dimensions: null,
  });

  if (glossA === null || glossB === null) {
    return unavailable(
      "Semantic distance is unavailable because one or both canonical taxonomy hierarchy paths are missing.",
    );
  }
  if (!runtime.available) {
    return unavailable(
      "Semantic distance is unavailable because no embedding provider credentials are configured.",
    );
  }
  if (abortSignal?.aborted === true) {
    return unavailable(
      "Semantic distance is unavailable because the request was aborted before embedding.",
    );
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(),
    SEMANTIC_EMBEDDING_TIMEOUT_MS,
  );
  const combinedSignal =
    abortSignal === undefined
      ? timeoutController.signal
      : AbortSignal.any([abortSignal, timeoutController.signal]);
  try {
    const results = await runtime.embedMany([glossA, glossB], {
      abortSignal: combinedSignal,
    });
    const resultA = results[0];
    const resultB = results[1];
    if (
      results.length !== 2 ||
      resultA === undefined ||
      resultB === undefined ||
      resultA.text !== glossA ||
      resultB.text !== glossB
    ) {
      throw new Error(
        "Embedding results did not preserve the two canonical gloss inputs.",
      );
    }
    const value = computeEmbeddingCosineDistance(
      resultA.embedding,
      resultB.embedding,
    );
    return {
      ...base,
      value,
      reason: null,
      vectorHashes: {
        encoding: VECTOR_HASH_ENCODING,
        categoryA: hashEmbeddingVector(resultA.embedding),
        categoryB: hashEmbeddingVector(resultB.embedding),
      },
      dimensions: resultA.embedding.length,
    };
  } catch (error) {
    if (timeoutController.signal.aborted) {
      return unavailable(
        `Semantic embedding exceeded the ${SEMANTIC_EMBEDDING_TIMEOUT_MS / 1000}-second timeout.`,
      );
    }
    if (abortSignal?.aborted === true) {
      return unavailable(
        "Semantic distance is unavailable because the request was aborted during embedding.",
      );
    }
    return unavailable(
      `Semantic embedding failed: ${boundedSemanticReason(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Calculate occupied-cell marginals, overlap, expectation, and global lift. */
export function calculateObservedCellStatistics(
  cells: readonly GridCellEvidence[],
): {
  readonly occupiedCells: number;
  readonly cellsWithCategoryA: number;
  readonly cellsWithCategoryB: number;
  readonly jointCells: number;
  readonly independenceExpectedJointCells: number | null;
  readonly globalLift: number | null;
} {
  const occupiedCells = cells.length;
  const cellsWithCategoryA = cells.filter((cell) => cell.hasCategoryA).length;
  const cellsWithCategoryB = cells.filter((cell) => cell.hasCategoryB).length;
  const jointCells = cells.filter(
    (cell) => cell.hasCategoryA && cell.hasCategoryB,
  ).length;
  const independenceExpectedJointCells =
    occupiedCells === 0
      ? null
      : (cellsWithCategoryA * cellsWithCategoryB) / occupiedCells;
  const globalLift =
    cellsWithCategoryA === 0 || cellsWithCategoryB === 0
      ? null
      : (jointCells * occupiedCells) /
        (cellsWithCategoryA * cellsWithCategoryB);
  return {
    occupiedCells,
    cellsWithCategoryA,
    cellsWithCategoryB,
    jointCells,
    independenceExpectedJointCells,
    globalLift,
  };
}

/** Enforce the valid-coordinate place preflight without truncation. */
export function assertValidCoordinatePlaceLimit(count: number): void {
  if (count > MAX_COLOCATION_PLACES) {
    throw new Error(
      `Co-location analysis refused: ${count} valid-coordinate places exceeds the hard limit of ${MAX_COLOCATION_PLACES}; no places were truncated or analyzed.`,
    );
  }
}

/** Enforce the occupied-cell preflight without truncation. */
export function assertOccupiedCellLimit(count: number): void {
  if (count > MAX_COLOCATION_CELLS) {
    throw new Error(
      `Co-location analysis refused: ${count} occupied cells exceeds the hard limit of ${MAX_COLOCATION_CELLS}; no cells were truncated or analyzed.`,
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildStrata(cells: readonly GridCellEvidence[]): Stratum[] {
  const grouped = new Map<string, GridCellEvidence[]>();
  for (const cell of cells) {
    const macroLatitudeIndex = Math.floor(cell.latitudeIndex / 8);
    const macroLongitudeIndex = Math.floor(cell.longitudeIndex / 8);
    const densityBand = Math.floor(Math.log2(cell.density));
    const id = `${macroLatitudeIndex}:${macroLongitudeIndex}:${densityBand}`;
    const stratum = grouped.get(id);
    if (stratum === undefined) {
      grouped.set(id, [cell]);
    } else {
      stratum.push(cell);
    }
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, stratumCells]) => {
      const categoryBCellCount = stratumCells.filter(
        (cell) => cell.hasCategoryB,
      ).length;
      const categoryACellCount = stratumCells.filter(
        (cell) => cell.hasCategoryA,
      ).length;
      const minimumOverlap = Math.max(
        0,
        categoryACellCount + categoryBCellCount - stratumCells.length,
      );
      const maximumOverlap = Math.min(categoryACellCount, categoryBCellCount);
      return {
        id,
        cells: [...stratumCells].sort((left, right) =>
          left.cellId.localeCompare(right.cellId),
        ),
        categoryBCellCount,
        categoryACellCount,
        overlapCanVary: minimumOverlap < maximumOverlap,
      };
    });
}

/**
 * Run the fixed 199-permutation geography-and-density-conditioned null model.
 */
export function runDensityConditionedNullModel(
  cells: readonly GridCellEvidence[],
  seed: string,
  observedJointCells: number,
): NullModelEvidence {
  const strata = buildStrata(cells);
  const permutableStrata = strata.filter((stratum) => stratum.overlapCanVary);
  const fixedStrata = strata.filter((stratum) => !stratum.overlapCanVary);
  const nullCounts: number[] = [];

  for (
    let permutationIndex = 0;
    permutationIndex < COLOCATION_PERMUTATIONS;
    permutationIndex += 1
  ) {
    let jointCells = 0;
    for (const stratum of strata) {
      if (!stratum.overlapCanVary) {
        jointCells += Math.max(
          0,
          stratum.categoryACellCount +
            stratum.categoryBCellCount -
            stratum.cells.length,
        );
        continue;
      }
      const assignedCategoryB = stratum.cells
        .map((cell) => ({
          cell,
          hash: sha256(
            `${seed}|${permutationIndex}|${stratum.id}|${cell.cellId}`,
          ),
        }))
        .sort(
          (left, right) =>
            left.hash.localeCompare(right.hash) ||
            left.cell.cellId.localeCompare(right.cell.cellId),
        )
        .slice(0, stratum.categoryBCellCount);
      jointCells += assignedCategoryB.filter(
        ({ cell }) => cell.hasCategoryA,
      ).length;
    }
    nullCounts.push(jointCells);
  }

  const meanExpectedJointCells =
    nullCounts.reduce((sum, count) => sum + count, 0) / nullCounts.length;
  const variance =
    nullCounts.reduce(
      (sum, count) => sum + (count - meanExpectedJointCells) ** 2,
      0,
    ) / nullCounts.length;
  const standardDeviationJointCells = Math.sqrt(variance);
  const noPermutationReason =
    permutableStrata.length === 0
      ? "No stratum permits category B reassignment that can change category A/B overlap."
      : null;
  const exceedanceCount = nullCounts.filter(
    (count) => count >= observedJointCells,
  ).length;

  return {
    description:
      "Category A occupied cells are fixed. Within each 8x8 parent-grid and floor(log2(cellDensity)) stratum, the exact category B occupied-cell count is reassigned by ascending SHA-256(seed|permutationIndex|stratum|cellId). Mean and population standard deviation summarize 199 null joint-cell counts; one-sided p=(1+count(null>=observed))/200 and conditioned lift=observed/nullMean.",
    version: NULL_MODEL_VERSION,
    permutations: COLOCATION_PERMUTATIONS,
    meanExpectedJointCells,
    standardDeviationJointCells,
    pValue:
      noPermutationReason === null
        ? (1 + exceedanceCount) / (COLOCATION_PERMUTATIONS + 1)
        : null,
    densityConditionedLift:
      meanExpectedJointCells === 0
        ? null
        : observedJointCells / meanExpectedJointCells,
    permutableStratumCount: permutableStrata.length,
    fixedStratumCount: fixedStrata.length,
    noPermutationReason,
    seed,
  };
}

function numberValue(value: Json | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint" || typeof value === "string") {
    return Number(value);
  }
  return Number.NaN;
}

function countValue(value: Json | undefined): number {
  const parsed = numberValue(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableString(value: Json | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function bindAdditional(params: DuckDBValue[], value: DuckDBValue): string {
  params.push(value);
  return `$${params.length}`;
}

function buildUniverseFilters(request: PlaceColocationRequest): PlaceFilters {
  return {
    hostedService: request.hostedService ?? "exclude",
    operatingStatus: request.operatingStatus?.trim(),
    minConfidence: request.minConfidence,
  };
}

async function readPreflight(
  connection: DuckDBConnection,
  countyKey: string,
  filters: PlaceFilters,
  categoryA: string,
  categoryB: string,
  abortSignal?: AbortSignal,
): Promise<PreflightSummary> {
  const predicate = buildPlacePredicate(countyKey, filters);
  const params = [...predicate.params];
  const categoryAPlaceholder = bindAdditional(params, categoryA);
  const categoryBPlaceholder = bindAdditional(params, categoryB);
  const rows = await readPlaceRows(
    connection,
    `SELECT
       count(*) AS total_filtered_places,
       count(*) FILTER (WHERE ${VALID_COORDINATE_SQL}) AS valid_coordinate_places,
       count(*) FILTER (WHERE taxonomy_primary = ${categoryAPlaceholder}) AS category_a_total_places,
       count(*) FILTER (
         WHERE taxonomy_primary = ${categoryAPlaceholder}
           AND ${VALID_COORDINATE_SQL}
       ) AS category_a_coordinate_places,
       count(*) FILTER (WHERE taxonomy_primary = ${categoryBPlaceholder}) AS category_b_total_places,
       count(*) FILTER (
         WHERE taxonomy_primary = ${categoryBPlaceholder}
           AND ${VALID_COORDINATE_SQL}
       ) AS category_b_coordinate_places,
       min(latitude) FILTER (WHERE ${VALID_COORDINATE_SQL}) AS min_latitude,
       max(latitude) FILTER (WHERE ${VALID_COORDINATE_SQL}) AS max_latitude,
       min(longitude) FILTER (WHERE ${VALID_COORDINATE_SQL}) AS min_longitude,
       max(longitude) FILTER (WHERE ${VALID_COORDINATE_SQL}) AS max_longitude,
       min(overture_release) AS minimum_release,
       max(overture_release) AS maximum_release,
       count(DISTINCT overture_release) AS distinct_release_count,
       count(*) FILTER (WHERE overture_release IS NULL) AS null_release_count
     FROM ${PLACES_VIEW}
     WHERE ${predicate.sql}`,
    params,
    { abortSignal },
  );
  const row = rows[0] ?? {};
  return {
    totalFilteredPlaces: countValue(row.total_filtered_places),
    validCoordinatePlaces: countValue(row.valid_coordinate_places),
    categoryATotalPlaces: countValue(row.category_a_total_places),
    categoryACoordinatePlaces: countValue(row.category_a_coordinate_places),
    categoryBTotalPlaces: countValue(row.category_b_total_places),
    categoryBCoordinatePlaces: countValue(row.category_b_coordinate_places),
    minLatitude: numberValue(row.min_latitude),
    maxLatitude: numberValue(row.max_latitude),
    minLongitude: numberValue(row.min_longitude),
    maxLongitude: numberValue(row.max_longitude),
    minimumRelease: nullableString(row.minimum_release),
    maximumRelease: nullableString(row.maximum_release),
    distinctReleaseCount: countValue(row.distinct_release_count),
    nullReleaseCount: countValue(row.null_release_count),
  };
}

function gridCellSql(
  predicateSql: string,
  latitudeStepPlaceholder: string,
  longitudeStepPlaceholder: string,
): string {
  return `WITH valid_places AS (
    SELECT
      CAST(floor((latitude + 90) / ${latitudeStepPlaceholder}) AS BIGINT) AS latitude_index,
      CAST(floor((longitude + 180) / ${longitudeStepPlaceholder}) AS BIGINT) AS longitude_index,
      taxonomy_primary
    FROM ${PLACES_VIEW}
    WHERE ${predicateSql}
      AND ${VALID_COORDINATE_SQL}
  ),
  cells AS (
    SELECT
      latitude_index,
      longitude_index,
      count(*) AS density,
      count(*) FILTER (WHERE taxonomy_primary = CATEGORY_A_PLACEHOLDER) AS category_a_count,
      count(*) FILTER (WHERE taxonomy_primary = CATEGORY_B_PLACEHOLDER) AS category_b_count
    FROM valid_places
    GROUP BY latitude_index, longitude_index
  )`;
}

function prepareCellQuery(
  countyKey: string,
  filters: PlaceFilters,
  grid: GridDefinition,
  categoryA: string,
  categoryB: string,
): { readonly cte: string; readonly params: DuckDBValue[] } {
  const predicate = buildPlacePredicate(countyKey, filters);
  const params = [...predicate.params];
  const latitudeStepPlaceholder = bindAdditional(
    params,
    grid.latitudeStepDegrees,
  );
  const longitudeStepPlaceholder = bindAdditional(
    params,
    grid.longitudeStepDegrees,
  );
  const categoryAPlaceholder = bindAdditional(params, categoryA);
  const categoryBPlaceholder = bindAdditional(params, categoryB);
  return {
    cte: gridCellSql(
      predicate.sql,
      latitudeStepPlaceholder,
      longitudeStepPlaceholder,
    )
      .replace("CATEGORY_A_PLACEHOLDER", categoryAPlaceholder)
      .replace("CATEGORY_B_PLACEHOLDER", categoryBPlaceholder),
    params,
  };
}

async function readCells(
  connection: DuckDBConnection,
  countyKey: string,
  filters: PlaceFilters,
  grid: GridDefinition,
  categoryA: string,
  categoryB: string,
  abortSignal?: AbortSignal,
): Promise<GridCellEvidence[]> {
  const query = prepareCellQuery(
    countyKey,
    filters,
    grid,
    categoryA,
    categoryB,
  );
  const countRows = await readPlaceRows(
    connection,
    `${query.cte}
     SELECT count(*) AS occupied_cells FROM cells`,
    [...query.params],
    { abortSignal },
  );
  const occupiedCells = countValue(countRows[0]?.occupied_cells);
  assertOccupiedCellLimit(occupiedCells);
  const rows = await readPlaceRows(
    connection,
    `${query.cte}
     SELECT latitude_index, longitude_index, density,
            category_a_count, category_b_count
     FROM cells
     ORDER BY latitude_index ASC, longitude_index ASC`,
    [...query.params],
    { abortSignal },
  );
  return rows.map((row) => {
    const latitudeIndex = countValue(row.latitude_index);
    const longitudeIndex = countValue(row.longitude_index);
    return {
      cellId: `${latitudeIndex}:${longitudeIndex}`,
      latitudeIndex,
      longitudeIndex,
      density: countValue(row.density),
      hasCategoryA: countValue(row.category_a_count) > 0,
      hasCategoryB: countValue(row.category_b_count) > 0,
    };
  });
}

async function readModalPaths(
  connection: DuckDBConnection,
  countyKey: string,
  filters: PlaceFilters,
  categoryA: string,
  categoryB: string,
  abortSignal?: AbortSignal,
): Promise<ModalPathRow[]> {
  const predicate = buildPlacePredicate(countyKey, filters);
  const params = [...predicate.params];
  const categoryAPlaceholder = bindAdditional(params, categoryA);
  const categoryBPlaceholder = bindAdditional(params, categoryB);
  const rows = await readPlaceRows(
    connection,
    `WITH path_counts AS (
       SELECT taxonomy_primary AS category_id,
              lower(trim(taxonomy_hierarchy)) AS path,
              count(*) AS support_count
       FROM ${PLACES_VIEW}
       WHERE ${predicate.sql}
         AND ${VALID_COORDINATE_SQL}
         AND taxonomy_primary IN (${categoryAPlaceholder}, ${categoryBPlaceholder})
         AND taxonomy_hierarchy IS NOT NULL
         AND trim(taxonomy_hierarchy) <> ''
       GROUP BY taxonomy_primary, lower(trim(taxonomy_hierarchy))
     ),
     modal_support AS (
       SELECT *, max(support_count) OVER (PARTITION BY category_id) AS maximum_support
       FROM path_counts
     )
     SELECT category_id,
            min(path) FILTER (WHERE support_count = maximum_support) AS path,
            max(maximum_support) AS support_count,
            count(*) FILTER (WHERE support_count = maximum_support) - 1 AS ambiguity_count
     FROM modal_support
     GROUP BY category_id
     ORDER BY category_id ASC`,
    params,
    { abortSignal },
  );
  return rows.map((row) => ({
    categoryId: String(row.category_id ?? ""),
    path: String(row.path ?? ""),
    supportCount: countValue(row.support_count),
    ambiguityCount: countValue(row.ambiguity_count),
  }));
}

function modalEvidence(
  rows: readonly ModalPathRow[],
  categoryId: string,
  coordinateCategoryCount: number,
): ModalPathEvidence {
  const row = rows.find((candidate) => candidate.categoryId === categoryId);
  if (row === undefined) {
    return selectModalHierarchyPath([], coordinateCategoryCount);
  }
  return {
    path: row.path,
    supportCount: row.supportCount,
    coverage:
      coordinateCategoryCount === 0
        ? null
        : row.supportCount / coordinateCategoryCount,
    ambiguityCount: row.ambiguityCount,
  };
}

function releaseIdentity(
  preflight: PreflightSummary,
  immutablePlacesTable: ImmutablePlacesTableProvenance,
): string {
  const minimum = preflight.minimumRelease ?? "null";
  const maximum = preflight.maximumRelease ?? "null";
  return [
    `min=${minimum}`,
    `max=${maximum}`,
    `distinct=${preflight.distinctReleaseCount}`,
    `nullRows=${preflight.nullReleaseCount}`,
    `immutableStatus=${immutablePlacesTable.status}`,
    `rootCid=${immutablePlacesTable.rootCid ?? "null"}`,
    `contentCid=${immutablePlacesTable.contentCid ?? "null"}`,
    `tableIdentityDigest=${immutablePlacesTable.identityDigest ?? "null"}`,
  ].join(";");
}

function categoryLabel(categoryId: string): string {
  return categoryId.replaceAll("_", " ");
}

function defaultEmbeddingRuntime(): PlaceColocationEmbeddingRuntime {
  return {
    // Bedrock can use instance-role credentials that the synchronous
    // hasEmbeddingProvider() heuristic cannot observe, so the provider call is
    // the authoritative availability check.
    available: true,
    provider: getEmbeddingProvider(),
    model: getActiveEmbeddingModel(),
    embedMany: embedManyTexts,
  };
}

function categoryEvidence(
  id: string,
  totalPlaces: number,
  coordinatePlaces: number,
  hierarchy: ModalPathEvidence,
): CategoryEvidence {
  return {
    id,
    label: categoryLabel(id),
    totalPlaces,
    coordinatePlaces,
    coordinateCoverage:
      totalPlaces === 0 ? null : coordinatePlaces / totalPlaces,
    hierarchy,
  };
}

/**
 * Analyze one exact unordered Overture primary-category pair in one published
 * county, returning bounded occupied-cell evidence and no publish decision.
 */
export async function runPlaceColocationAnalysis(
  request: PlaceColocationRequest,
  options: PlaceColocationRuntimeOptions = {},
): Promise<PlaceColocationEvidence> {
  const [categoryA, categoryB] = canonicalizeCategoryPair(
    request.categoryA,
    request.categoryB,
  );
  const gridCellSizeMeters =
    request.gridCellSizeMeters ?? DEFAULT_GRID_CELL_SIZE_METERS;
  const catalogDataset = await resolvePublishedPlacesDataset(request.county);
  const immutablePlacesTable = await resolveCatalogPlacesTableProvenance(
    catalogDataset.tableUrl,
    { abortSignal: options.abortSignal },
  );
  const dataset =
    immutablePlacesTable.immutableTableUrl === null
      ? catalogDataset
      : {
          ...catalogDataset,
          tableUrl:
            immutablePlacesTable.immutableContentUrl ??
            immutablePlacesTable.immutableTableUrl,
        };
  const filters = buildUniverseFilters(request);
  const provenancePromise = getPlaceProvenance(
    catalogDataset,
    immutablePlacesTable,
  );

  const analysis = await withPlaceConnection(
    dataset,
    async (
      connection,
    ): Promise<{
      readonly preflight: PreflightSummary;
      readonly grid: GridDefinition;
      readonly cells: GridCellEvidence[];
      readonly modalPaths: ModalPathRow[];
    }> => {
      const preflight = await readPreflight(
        connection,
        dataset.countyKey,
        filters,
        categoryA,
        categoryB,
        options.abortSignal,
      );
      assertValidCoordinatePlaceLimit(preflight.validCoordinatePlaces);
      if (preflight.validCoordinatePlaces === 0) {
        throw new Error(
          "Co-location analysis requires at least one valid-coordinate place in the filtered county universe.",
        );
      }
      if (
        !Number.isFinite(preflight.minLatitude) ||
        !Number.isFinite(preflight.maxLatitude) ||
        !Number.isFinite(preflight.minLongitude) ||
        !Number.isFinite(preflight.maxLongitude) ||
        preflight.minLatitude >= preflight.maxLatitude ||
        preflight.minLongitude >= preflight.maxLongitude
      ) {
        throw new Error(
          "Cannot construct the co-location grid from polar or degenerate coordinate bounds.",
        );
      }
      const grid = computeGridDefinition(
        gridCellSizeMeters,
        preflight.minLatitude,
        preflight.maxLatitude,
      );
      const cells = await readCells(
        connection,
        dataset.countyKey,
        filters,
        grid,
        categoryA,
        categoryB,
        options.abortSignal,
      );
      const modalPaths = await readModalPaths(
        connection,
        dataset.countyKey,
        filters,
        categoryA,
        categoryB,
        options.abortSignal,
      );
      return { preflight, grid, cells, modalPaths };
    },
    { abortSignal: options.abortSignal },
  );

  const observed = calculateObservedCellStatistics(analysis.cells);
  const identity = releaseIdentity(analysis.preflight, immutablePlacesTable);
  const seed = sha256(
    [
      dataset.countyKey,
      categoryA,
      categoryB,
      gridCellSizeMeters,
      dataset.updatedAt,
      dataset.tableUrl,
      identity,
    ].join("|"),
  );
  const densityConditionedNull = runDensityConditionedNullModel(
    analysis.cells,
    seed,
    observed.jointCells,
  );
  const hierarchyA = modalEvidence(
    analysis.modalPaths,
    categoryA,
    analysis.preflight.categoryACoordinatePlaces,
  );
  const hierarchyB = modalEvidence(
    analysis.modalPaths,
    categoryB,
    analysis.preflight.categoryBCoordinatePlaces,
  );
  const [provenance, semanticDistance] = await Promise.all([
    provenancePromise,
    computeGlossedSemanticDistance(
      { id: categoryA, hierarchyPath: hierarchyA.path },
      { id: categoryB, hierarchyPath: hierarchyB.path },
      options.embedding ?? defaultEmbeddingRuntime(),
      options.abortSignal,
    ),
  ]);

  return {
    county: {
      key: dataset.countyKey,
      name: dataset.countyName,
      stateCode: dataset.stateCode,
      fips: dataset.countyFips,
    },
    inputs: {
      county: dataset.countyKey,
      categoryA,
      categoryB,
      gridCellSizeMeters,
      hostedService: request.hostedService ?? "exclude",
      operatingStatus: request.operatingStatus?.trim() ?? null,
      minConfidence: request.minConfidence ?? null,
    },
    universe: {
      unit: "occupied fixed grid cells",
      totalFilteredPlaces: analysis.preflight.totalFilteredPlaces,
      validCoordinatePlaces: analysis.preflight.validCoordinatePlaces,
      coordinateCoverage:
        analysis.preflight.validCoordinatePlaces /
        analysis.preflight.totalFilteredPlaces,
      occupiedCells: observed.occupiedCells,
    },
    grid: analysis.grid,
    categories: {
      a: categoryEvidence(
        categoryA,
        analysis.preflight.categoryATotalPlaces,
        analysis.preflight.categoryACoordinatePlaces,
        hierarchyA,
      ),
      b: categoryEvidence(
        categoryB,
        analysis.preflight.categoryBTotalPlaces,
        analysis.preflight.categoryBCoordinatePlaces,
        hierarchyB,
      ),
    },
    observed: {
      cellsWithCategoryA: observed.cellsWithCategoryA,
      cellsWithCategoryB: observed.cellsWithCategoryB,
      jointCells: observed.jointCells,
      independenceExpectedJointCells: observed.independenceExpectedJointCells,
      globalLift: observed.globalLift,
      independenceExpectedFormula:
        "cellsWithCategoryA * cellsWithCategoryB / occupiedCells",
      globalLiftFormula:
        "jointCells * occupiedCells / (cellsWithCategoryA * cellsWithCategoryB)",
    },
    densityConditionedNull: {
      ...densityConditionedNull,
    },
    taxonomyDistance: {
      value: computeTaxonomyTreeDistance(hierarchyA.path, hierarchyB.path),
      formula: "1 - (2 * longestCommonPrefixSegments) / (depthA + depthB)",
      version: TAXONOMY_DISTANCE_VERSION,
    },
    semanticDistance,
    semanticCalibration: {
      empiricalPercentile: null,
      reason:
        "Single-pair analysis does not embed the complete eligible category universe and therefore cannot provide an auditable calibrated semantic percentile.",
      discoverySourceRequiredForClassH: true,
    },
    provenance: {
      ...provenance,
      releaseIdentity: identity,
    },
    method: {
      grid: GRID_FORMULA_VERSION,
      nullModel: NULL_MODEL_VERSION,
      taxonomyDistance: TAXONOMY_DISTANCE_VERSION,
      semanticDistance: SEMANTIC_DISTANCE_VERSION,
    },
    rerunContract:
      immutablePlacesTable.status === "resolved"
        ? "Rerun with the canonical county/category inputs and filters shown above against immutablePlacesTable.immutableTableUrl with the same rootCid, contentCid (when exposed), table identity digest, catalogUpdatedAt, releaseIdentity, method versions, embedding provider/model, exact gloss inputs, vector encoding, and caller-independent seed."
        : "Exact rerun is unavailable because immutable places-table provenance could not be resolved. The mutable placesTableUrl is diagnostic input only and must not be treated as an exact rerun locator.",
    decisionNote: `This tool is diagnostic pair evidence only and is non-publishable. It does not apply lift, magnitude, semantic-distance, p-value, publication, or Watchog decision thresholds. discoverPlaceColocationCandidates is the publishable Class H source unless a caller separately supplies auditable calibrated-percentile evidence. A null semanticDistance must fail closed downstream.${
      immutablePlacesTable.status === "resolved"
        ? ""
        : ` Immutable provenance is ${immutablePlacesTable.status}: ${immutablePlacesTable.reason ?? "no immutable identity was established"}.`
    }`,
  };
}
