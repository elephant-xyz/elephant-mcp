import { createHash } from "node:crypto";

import type { DuckDBConnection, Json } from "@duckdb/node-api";

import { getEmbeddingProvider, type EmbeddingProvider } from "../config.ts";
import { logger } from "../logger.ts";
import {
  embedManyTexts,
  getActiveEmbeddingModel,
  type EmbeddingResult,
} from "./embeddings.ts";
import {
  DEFAULT_GRID_CELL_SIZE_METERS,
  GRID_FORMULA_VERSION,
  MAX_COLOCATION_CELLS,
  MAX_COLOCATION_PLACES,
  SEMANTIC_DISTANCE_VERSION,
  SEMANTIC_EMBEDDING_TIMEOUT_MS,
  SEMANTIC_GLOSS_VERSION,
  VECTOR_HASH_ENCODING,
  assertOccupiedCellLimit,
  assertValidCoordinatePlaceLimit,
  buildCategorySemanticGloss,
  computeEmbeddingCosineDistance,
  computeGridDefinition,
  hashEmbeddingVector,
  type GridDefinition,
  type ModalPathEvidence,
  type PlaceColocationEmbeddingRuntime,
} from "./placeColocation.ts";
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
  type PlaceProvenance,
} from "./placeQuery.ts";

export const DISCOVERY_METHOD_VERSION =
  "place-colocation-candidate-discovery-v2" as const;
export const DISCOVERY_SPLIT_VERSION =
  "stratified-sha256-cell-split-v1" as const;
// Preserve the calibrated v1 cell assignment when other discovery stages
// advance independently. This was the namespace used by the original split.
export const DISCOVERY_SPLIT_SEED_VERSION =
  "place-colocation-candidate-discovery-v1" as const;
export const DISCOVERY_ANALYTIC_VERSION =
  "stratified-hypergeometric-moments-v1" as const;
export const DISCOVERY_EXACT_NULL_VERSION =
  "stratified-hypergeometric-convolution-v1" as const;
export const DISCOVERY_HOLM_VERSION = "holm-fwer-v1" as const;
export const MIN_ELIGIBLE_CATEGORY_CELLS = 50 as const;
export const MAX_ELIGIBLE_CATEGORIES = 256 as const;
export const MAX_PAIR_FRONTIER = 32_640 as const;
export const DISCOVERY_MIN_JOINT_CELLS = 20 as const;
export const DISCOVERY_MIN_RAW_LIFT = 2 as const;
export const MAX_SEMANTIC_FRONTIER = 32 as const;
export const SEMANTIC_GUARD_VERSION =
  "full-eligible-universe-empirical-cdf-v1" as const;
export const MIN_SEMANTIC_DISTANCE = 0.35 as const;
export const MIN_SEMANTIC_PERCENTILE = 0.8 as const;
export const MAX_VALIDATION_FAMILY = 5 as const;
export const VALIDATION_MIN_JOINT_CELLS = 20 as const;
export const VALIDATION_MIN_RAW_LIFT = 2 as const;
export const FULL_MIN_JOINT_CELLS = 50 as const;
export const FULL_MIN_OCCUPIED_FRACTION = 0.02 as const;
export const EXACT_NULL_MAX_STATES = 20_001 as const;
export const EXACT_NULL_MAX_TRANSITIONS = 5_000_000 as const;
export const EXACT_NULL_EPSILON = 1e-12 as const;
export const DISCOVERY_QUERY_TIMEOUT_MS = 120_000 as const;
export const SEMANTIC_LEDGER_DIGEST_VERSION =
  "semantic-evaluation-ledger-sha256-v2" as const;
export const SEMANTIC_LEDGER_DIGEST_ENCODING =
  "SHA-256 over UTF-8 JSON Lines sorted by canonical categoryA then categoryB; each line is [categoryA,categoryB,provider,model,semanticMethod,glossMethod,guardMethod,vectorHashA,vectorHashB,distanceIEEE754Binary64BigEndianHex,inclusiveCdfNumerator,referencePairCount] followed by LF" as const;
export const SEMANTIC_CORPUS_DIGEST_VERSION =
  "eligible-semantic-corpus-sha256-v1" as const;
export const SEMANTIC_CORPUS_DIGEST_ENCODING =
  "SHA-256 over UTF-8 JSON Lines sorted by category ID; each line is [categoryId,provider,model,semanticMethod,glossMethod,canonicalGloss,vectorHash] followed by LF" as const;
export const SEMANTIC_DISTRIBUTION_DIGEST_VERSION =
  "eligible-semantic-distribution-sha256-v1" as const;
export const SEMANTIC_DISTRIBUTION_DIGEST_ENCODING =
  SEMANTIC_LEDGER_DIGEST_ENCODING;

const VALID_COORDINATE_SQL = [
  "latitude IS NOT NULL",
  "longitude IS NOT NULL",
  "isfinite(latitude)",
  "isfinite(longitude)",
  "latitude BETWEEN -90 AND 90",
  "longitude BETWEEN -180 AND 180",
].join(" AND ");

export interface PlaceColocationDiscoveryRequest {
  readonly county: string;
}

export interface DiscoveryCell {
  readonly cellId: string;
  readonly latitudeIndex: number;
  readonly longitudeIndex: number;
  readonly density: number;
  readonly categories: readonly string[];
}

export interface DiscoveryCategory {
  readonly id: string;
  readonly label: string;
  readonly hierarchy: ModalPathEvidence;
}

export interface HypergeometricMoments {
  readonly expectation: number;
  readonly variance: number;
}

export interface ExactStratifiedNullResult {
  readonly rawPValue: number | null;
  readonly conservativePValue: number | null;
  readonly meanExpectedJointCells: number;
  readonly varianceJointCells: number;
  readonly stateCount: number;
  readonly transitionCount: number;
  readonly normalizationError: number | null;
  readonly reason: string | null;
}

export interface PairCounts {
  readonly categoryA: string;
  readonly categoryB: string;
  readonly cellsWithCategoryA: number;
  readonly cellsWithCategoryB: number;
  readonly jointCells: number;
  readonly rawLift: number | null;
  readonly expectation: number;
  readonly variance: number;
  readonly zScore: number | null;
  readonly zeroVarianceExcess: boolean;
}

interface RankedDiscoveryPair extends PairCounts {
  readonly rank: number;
}

interface SemanticVector {
  readonly gloss: string;
  readonly vector: readonly number[];
  readonly vectorHash: string;
}

export interface DiscoveryEngineResult {
  readonly census: {
    readonly occupiedCells: number;
    readonly eligibleCategories: number;
    readonly declaredPairFrontier: number;
    readonly discoveryGuardPassingPairs: number;
    readonly semanticUniqueCategories: number;
    readonly semanticReferencePairs: number;
    readonly semanticEvaluatedPairs: number;
    readonly semanticFrontierPairs: number;
    readonly semanticPassingPairs: number;
    readonly validationFamilyPairs: number;
  };
  readonly split: {
    readonly version: typeof DISCOVERY_SPLIT_VERSION;
    readonly discoveryCells: number;
    readonly validationCells: number;
    readonly discoveryFraction: number;
    readonly absoluteCellImbalance: number;
    readonly strata: number;
    readonly discoveryStrata: number;
    readonly validationStrata: number;
    readonly singletonStrata: number;
    readonly maximumWithinStratumImbalance: number;
    readonly seed: string;
  };
  readonly semanticFrontier: readonly SemanticFrontierEvidence[];
  readonly semanticAudit: {
    readonly guardVersion: typeof SEMANTIC_GUARD_VERSION;
    readonly percentileMeaning: string;
    readonly corpus: {
      readonly version: typeof SEMANTIC_CORPUS_DIGEST_VERSION;
      readonly encoding: typeof SEMANTIC_CORPUS_DIGEST_ENCODING;
      readonly digest: string | null;
      readonly eligibleCategories: number;
    };
    readonly referenceDistribution: {
      readonly version: typeof SEMANTIC_DISTRIBUTION_DIGEST_VERSION;
      readonly encoding: typeof SEMANTIC_DISTRIBUTION_DIGEST_ENCODING;
      readonly digest: string | null;
      readonly pairCount: number;
      readonly percentileMethod: string;
      readonly quantileMethod: string;
      readonly summary: {
        readonly minimum: number | null;
        readonly p20: number | null;
        readonly p50: number | null;
        readonly p80: number | null;
        readonly p90: number | null;
        readonly p95: number | null;
        readonly maximum: number | null;
      };
    };
    readonly spatialLedger: {
      readonly version: typeof SEMANTIC_LEDGER_DIGEST_VERSION;
      readonly encoding: typeof SEMANTIC_LEDGER_DIGEST_ENCODING;
      readonly digest: string | null;
      readonly entries: number;
    };
  };
  readonly validationFamily: readonly ValidationPairEvidence[];
  readonly emptyReason: string | null;
}

export interface SemanticFrontierEvidence {
  readonly rank: number;
  readonly discoveryRank: number;
  readonly categoryA: DiscoveryCategory;
  readonly categoryB: DiscoveryCategory;
  readonly discovery: PairCounts;
  readonly semantic: {
    readonly value: number | null;
    readonly reason: string | null;
    readonly formula: string;
    readonly version: typeof SEMANTIC_DISTANCE_VERSION;
    readonly provider: EmbeddingProvider;
    readonly model: string;
    readonly glossVersion: typeof SEMANTIC_GLOSS_VERSION;
    readonly timeoutMilliseconds: typeof SEMANTIC_EMBEDDING_TIMEOUT_MS;
    readonly minimumDistance: typeof MIN_SEMANTIC_DISTANCE;
    readonly minimumPercentile: typeof MIN_SEMANTIC_PERCENTILE;
    readonly empiricalPercentile: number | null;
    readonly referencePairCount: number;
    readonly guardVersion: typeof SEMANTIC_GUARD_VERSION;
    readonly passed: boolean;
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
  };
}

export interface ValidationPairEvidence {
  readonly discoveryRank: number;
  readonly categoryA: DiscoveryCategory;
  readonly categoryB: DiscoveryCategory;
  readonly semantic: SemanticFrontierEvidence["semantic"];
  readonly validation: PairCounts & {
    readonly null: ExactStratifiedNullResult & {
      readonly version: typeof DISCOVERY_EXACT_NULL_VERSION;
      readonly conditionedLift: number | null;
      readonly holmInputPValue: number;
      readonly holmAdjustedPValue: number;
      readonly holmFamilySize: number;
    };
    readonly guards: {
      readonly jointMinimum: typeof VALIDATION_MIN_JOINT_CELLS;
      readonly rawLiftMinimum: typeof VALIDATION_MIN_RAW_LIFT;
      readonly jointPassed: boolean;
      readonly rawLiftPassed: boolean;
    };
  };
  readonly fullUniverse: PairCounts & {
    readonly magnitudeFloor: number;
    readonly guards: {
      readonly jointPassed: boolean;
      readonly rawLiftPassed: boolean;
      readonly rawLiftMinimum: typeof DISCOVERY_MIN_RAW_LIFT;
    };
  };
}

export interface PlaceColocationDiscoveryEvidence {
  readonly county: {
    readonly key: string;
    readonly name: string;
    readonly stateCode: string;
    readonly fips: string;
  };
  readonly inputs: {
    readonly county: string;
  };
  readonly universe: {
    readonly unit: "occupied fixed grid cells";
    readonly hostedService: "exclude";
    readonly totalFilteredPlaces: number;
    readonly validCoordinatePlaces: number;
    readonly coordinateCoverage: number;
    readonly occupiedCells: number;
  };
  readonly grid: GridDefinition;
  readonly provenance: PlaceProvenance & {
    readonly releaseIdentity: string;
  };
  readonly seed: string;
  readonly counts: DiscoveryEngineResult["census"];
  readonly caps: {
    readonly maximumValidCoordinatePlaces: typeof MAX_COLOCATION_PLACES;
    readonly maximumOccupiedCells: typeof MAX_COLOCATION_CELLS;
    readonly minimumEligibleCategoryCells: typeof MIN_ELIGIBLE_CATEGORY_CELLS;
    readonly maximumEligibleCategories: typeof MAX_ELIGIBLE_CATEGORIES;
    readonly maximumPairFrontier: typeof MAX_PAIR_FRONTIER;
    readonly maximumSemanticFrontier: typeof MAX_SEMANTIC_FRONTIER;
    readonly maximumValidationFamily: typeof MAX_VALIDATION_FAMILY;
    readonly exactNullMaximumStates: typeof EXACT_NULL_MAX_STATES;
    readonly exactNullMaximumTransitions: typeof EXACT_NULL_MAX_TRANSITIONS;
  };
  readonly guards: {
    readonly discoveryMinimumJointCells: typeof DISCOVERY_MIN_JOINT_CELLS;
    readonly discoveryMinimumRawLift: typeof DISCOVERY_MIN_RAW_LIFT;
    readonly semanticMinimumDistance: typeof MIN_SEMANTIC_DISTANCE;
    readonly semanticMinimumPercentile: typeof MIN_SEMANTIC_PERCENTILE;
    readonly validationMinimumJointCells: typeof VALIDATION_MIN_JOINT_CELLS;
    readonly validationMinimumRawLift: typeof VALIDATION_MIN_RAW_LIFT;
    readonly fullMinimumJointCells: typeof FULL_MIN_JOINT_CELLS;
    readonly fullMinimumOccupiedFraction: typeof FULL_MIN_OCCUPIED_FRACTION;
  };
  readonly split: DiscoveryEngineResult["split"];
  readonly semanticAudit: DiscoveryEngineResult["semanticAudit"];
  readonly semanticFrontier: DiscoveryEngineResult["semanticFrontier"];
  readonly validationFamily: DiscoveryEngineResult["validationFamily"];
  readonly failure: {
    readonly failedClosed: boolean;
    readonly reason: string | null;
    readonly truncated: false;
  };
  readonly method: {
    readonly version: typeof DISCOVERY_METHOD_VERSION;
    readonly grid: typeof GRID_FORMULA_VERSION;
    readonly split: typeof DISCOVERY_SPLIT_VERSION;
    readonly splitSeed: typeof DISCOVERY_SPLIT_SEED_VERSION;
    readonly analyticRanking: typeof DISCOVERY_ANALYTIC_VERSION;
    readonly semanticDistance: typeof SEMANTIC_DISTANCE_VERSION;
    readonly semanticGuard: typeof SEMANTIC_GUARD_VERSION;
    readonly exactNull: typeof DISCOVERY_EXACT_NULL_VERSION;
    readonly holm: typeof DISCOVERY_HOLM_VERSION;
    readonly formulas: {
      readonly discoveryLift: string;
      readonly stratifiedExpectation: string;
      readonly stratifiedVariance: string;
      readonly zScore: string;
      readonly semanticEligibility: string;
      readonly exactTail: string;
      readonly holm: string;
      readonly fullMagnitudeFloor: string;
    };
  };
  readonly rerunContract: string;
  readonly decisionNote: string;
}

interface DiscoveryPreflight {
  readonly totalFilteredPlaces: number;
  readonly validCoordinatePlaces: number;
  readonly minLatitude: number;
  readonly maxLatitude: number;
  readonly minimumRelease: string | null;
  readonly maximumRelease: string | null;
  readonly distinctReleaseCount: number;
  readonly nullReleaseCount: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface SemanticLedgerEntry {
  readonly categoryA: string;
  readonly categoryB: string;
  readonly provider: EmbeddingProvider;
  readonly model: string;
  readonly vectorHashA: string;
  readonly vectorHashB: string;
  readonly distance: number;
  readonly inclusiveCdfNumerator: number;
  readonly referencePairCount: number;
}

export function encodeFloat64BigEndianHex(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("Semantic ledger distance must be finite.");
  }
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeDoubleBE(Object.is(value, -0) ? 0 : value);
  return buffer.toString("hex");
}

export function computeSemanticLedgerDigest(
  entries: readonly SemanticLedgerEntry[],
): string {
  const lines = [...entries]
    .map((entry) => {
      const [categoryA, categoryB, vectorHashA, vectorHashB] =
        entry.categoryA < entry.categoryB
          ? [
              entry.categoryA,
              entry.categoryB,
              entry.vectorHashA,
              entry.vectorHashB,
            ]
          : [
              entry.categoryB,
              entry.categoryA,
              entry.vectorHashB,
              entry.vectorHashA,
            ];
      return {
        categoryA,
        categoryB,
        line: JSON.stringify([
          categoryA,
          categoryB,
          entry.provider,
          entry.model,
          SEMANTIC_DISTANCE_VERSION,
          SEMANTIC_GLOSS_VERSION,
          SEMANTIC_GUARD_VERSION,
          vectorHashA,
          vectorHashB,
          encodeFloat64BigEndianHex(entry.distance),
          entry.inclusiveCdfNumerator,
          entry.referencePairCount,
        ]),
      };
    })
    .sort(
      (left, right) =>
        left.categoryA.localeCompare(right.categoryA) ||
        left.categoryB.localeCompare(right.categoryB),
    )
    .map(({ line }) => `${line}\n`)
    .join("");
  return sha256(lines);
}

export function computeSemanticCorpusDigest(
  categories: readonly {
    readonly id: string;
    readonly gloss: string;
    readonly vectorHash: string;
  }[],
  provider: EmbeddingProvider,
  model: string,
): string {
  const lines = [...categories]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(
      ({ id, gloss, vectorHash }) =>
        `${JSON.stringify([
          id,
          provider,
          model,
          SEMANTIC_DISTANCE_VERSION,
          SEMANTIC_GLOSS_VERSION,
          gloss,
          vectorHash,
        ])}\n`,
    )
    .join("");
  return sha256(lines);
}

export function inclusiveEmpiricalPercentile(
  sortedDistances: readonly number[],
  distance: number,
): { readonly numerator: number; readonly value: number } {
  let lower = 0;
  let upper = sortedDistances.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (sortedDistances[middle]! <= distance) lower = middle + 1;
    else upper = middle;
  }
  return {
    numerator: lower,
    value: sortedDistances.length === 0 ? 0 : lower / sortedDistances.length,
  };
}

export function nearestRankQuantile(
  sortedValues: readonly number[],
  probability: number,
): number | null {
  if (sortedValues.length === 0) return null;
  if (probability <= 0) return sortedValues[0]!;
  if (probability >= 1) return sortedValues[sortedValues.length - 1]!;
  return sortedValues[Math.ceil(probability * sortedValues.length) - 1]!;
}

export function passesCalibratedSemanticGuard(
  rawDistance: number,
  empiricalPercentile: number,
): boolean {
  return (
    rawDistance >= MIN_SEMANTIC_DISTANCE &&
    empiricalPercentile >= MIN_SEMANTIC_PERCENTILE
  );
}

function boundedReason(error: unknown): string {
  const value = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();
  return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
}

function numberValue(value: Json | undefined): number {
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "string"
  ) {
    return Number(value);
  }
  return Number.NaN;
}

function countValue(value: Json | undefined): number {
  const valueAsNumber = numberValue(value);
  return Number.isFinite(valueAsNumber) && valueAsNumber >= 0
    ? valueAsNumber
    : 0;
}

export function discoveryStratumId(
  cell: Pick<DiscoveryCell, "latitudeIndex" | "longitudeIndex" | "density">,
): string {
  return `${Math.floor(cell.latitudeIndex / 8)}:${Math.floor(
    cell.longitudeIndex / 8,
  )}:${Math.floor(Math.log2(cell.density))}`;
}

export function splitDiscoveryCells(
  cells: readonly DiscoveryCell[],
  seed: string,
): {
  readonly discovery: readonly DiscoveryCell[];
  readonly validation: readonly DiscoveryCell[];
  readonly strata: number;
  readonly discoveryStrata: number;
  readonly validationStrata: number;
  readonly singletonStrata: number;
  readonly maximumWithinStratumImbalance: number;
} {
  const grouped = new Map<string, DiscoveryCell[]>();
  for (const cell of cells) {
    const id = discoveryStratumId(cell);
    const existing = grouped.get(id);
    if (existing === undefined) grouped.set(id, [cell]);
    else existing.push(cell);
  }
  const discovery: DiscoveryCell[] = [];
  const validation: DiscoveryCell[] = [];
  let singletonStrata = 0;
  let maximumWithinStratumImbalance = 0;
  for (const [stratumId, stratumCells] of [...grouped.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const ordered = stratumCells
      .map((cell) => ({
        cell,
        hash: sha256(
          `${seed}|${DISCOVERY_SPLIT_VERSION}|${stratumId}|${cell.cellId}`,
        ),
      }))
      .sort(
        (left, right) =>
          left.hash.localeCompare(right.hash) ||
          left.cell.cellId.localeCompare(right.cell.cellId),
      );
    if (ordered.length === 1) {
      singletonStrata += 1;
      maximumWithinStratumImbalance = Math.max(
        maximumWithinStratumImbalance,
        1,
      );
      if (Number.parseInt(ordered[0]!.hash.slice(0, 2), 16) % 2 === 0) {
        discovery.push(ordered[0]!.cell);
      } else {
        validation.push(ordered[0]!.cell);
      }
    } else {
      const discoveryCount = Math.floor(ordered.length / 2);
      discovery.push(
        ...ordered.slice(0, discoveryCount).map(({ cell }) => cell),
      );
      validation.push(...ordered.slice(discoveryCount).map(({ cell }) => cell));
      maximumWithinStratumImbalance = Math.max(
        maximumWithinStratumImbalance,
        Math.abs(ordered.length - 2 * discoveryCount),
      );
    }
  }
  if (cells.length > 0 && (discovery.length === 0 || validation.length === 0)) {
    throw new Error(
      "Discovery split is degenerate: one side has no occupied cells.",
    );
  }
  return {
    discovery: discovery.sort((a, b) => a.cellId.localeCompare(b.cellId)),
    validation: validation.sort((a, b) => a.cellId.localeCompare(b.cellId)),
    strata: grouped.size,
    discoveryStrata: new Set(discovery.map(discoveryStratumId)).size,
    validationStrata: new Set(validation.map(discoveryStratumId)).size,
    singletonStrata,
    maximumWithinStratumImbalance,
  };
}

export function hypergeometricMoments(
  populationSize: number,
  categoryACells: number,
  categoryBCells: number,
): HypergeometricMoments {
  if (
    !Number.isInteger(populationSize) ||
    !Number.isInteger(categoryACells) ||
    !Number.isInteger(categoryBCells) ||
    populationSize < 1 ||
    categoryACells < 0 ||
    categoryBCells < 0 ||
    categoryACells > populationSize ||
    categoryBCells > populationSize
  ) {
    throw new Error("Invalid hypergeometric marginal counts.");
  }
  const expectation = (categoryACells * categoryBCells) / populationSize;
  if (populationSize === 1) return { expectation, variance: 0 };
  const fractionA = categoryACells / populationSize;
  const variance =
    categoryBCells *
    fractionA *
    (1 - fractionA) *
    ((populationSize - categoryBCells) / (populationSize - 1));
  return { expectation, variance };
}

function categorySet(cell: DiscoveryCell): ReadonlySet<string> {
  return new Set(cell.categories);
}

function occupiedMarginals(
  cells: readonly DiscoveryCell[],
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const cell of cells) {
    for (const category of cell.categories) {
      const existing = result.get(category);
      if (existing === undefined) result.set(category, new Set([cell.cellId]));
      else existing.add(cell.cellId);
    }
  }
  return result;
}

function pairMoments(
  cells: readonly DiscoveryCell[],
  categoryA: string,
  categoryB: string,
): HypergeometricMoments {
  const strata = new Map<string, DiscoveryCell[]>();
  for (const cell of cells) {
    const id = discoveryStratumId(cell);
    const existing = strata.get(id);
    if (existing === undefined) strata.set(id, [cell]);
    else existing.push(cell);
  }
  let expectation = 0;
  let variance = 0;
  for (const stratumCells of strata.values()) {
    const marginalA = stratumCells.filter((cell) =>
      categorySet(cell).has(categoryA),
    ).length;
    const marginalB = stratumCells.filter((cell) =>
      categorySet(cell).has(categoryB),
    ).length;
    const moments = hypergeometricMoments(
      stratumCells.length,
      marginalA,
      marginalB,
    );
    expectation += moments.expectation;
    variance += moments.variance;
  }
  return { expectation, variance };
}

function countPair(
  cells: readonly DiscoveryCell[],
  categoryA: string,
  categoryB: string,
): PairCounts {
  let cellsWithCategoryA = 0;
  let cellsWithCategoryB = 0;
  let jointCells = 0;
  for (const cell of cells) {
    const categories = categorySet(cell);
    const hasA = categories.has(categoryA);
    const hasB = categories.has(categoryB);
    if (hasA) cellsWithCategoryA += 1;
    if (hasB) cellsWithCategoryB += 1;
    if (hasA && hasB) jointCells += 1;
  }
  const rawLift =
    cellsWithCategoryA === 0 || cellsWithCategoryB === 0
      ? null
      : (jointCells * cells.length) / (cellsWithCategoryA * cellsWithCategoryB);
  const moments = pairMoments(cells, categoryA, categoryB);
  return {
    categoryA,
    categoryB,
    cellsWithCategoryA,
    cellsWithCategoryB,
    jointCells,
    rawLift,
    expectation: moments.expectation,
    variance: moments.variance,
    zScore:
      moments.variance === 0
        ? null
        : (jointCells - moments.expectation) / Math.sqrt(moments.variance),
    zeroVarianceExcess:
      moments.variance === 0 && jointCells > moments.expectation,
  };
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY;
  const reducedK = Math.min(k, n - k);
  let result = 0;
  for (let index = 1; index <= reducedK; index += 1) {
    result += Math.log(n - reducedK + index) - Math.log(index);
  }
  return result;
}

export function hypergeometricPmf(
  populationSize: number,
  categoryACells: number,
  categoryBCells: number,
): readonly number[] {
  hypergeometricMoments(populationSize, categoryACells, categoryBCells);
  const minimum = Math.max(0, categoryACells + categoryBCells - populationSize);
  const maximum = Math.min(categoryACells, categoryBCells);
  const result = Array.from({ length: maximum + 1 }, () => 0);
  const denominator = logChoose(populationSize, categoryBCells);
  for (let overlap = minimum; overlap <= maximum; overlap += 1) {
    result[overlap] = Math.exp(
      logChoose(categoryACells, overlap) +
        logChoose(populationSize - categoryACells, categoryBCells - overlap) -
        denominator,
    );
  }
  return result;
}

export function exactStratifiedHypergeometricNull(
  cells: readonly DiscoveryCell[],
  categoryA: string,
  categoryB: string,
  observedJointCells: number,
  bounds: {
    readonly maximumStates?: number;
    readonly maximumTransitions?: number;
  } = {},
): ExactStratifiedNullResult {
  const maximumStates = bounds.maximumStates ?? EXACT_NULL_MAX_STATES;
  const maximumTransitions =
    bounds.maximumTransitions ?? EXACT_NULL_MAX_TRANSITIONS;
  const strata = new Map<string, DiscoveryCell[]>();
  for (const cell of cells) {
    const id = discoveryStratumId(cell);
    const existing = strata.get(id);
    if (existing === undefined) strata.set(id, [cell]);
    else existing.push(cell);
  }
  const stratumNulls = [...strata.values()].map((stratumCells) => {
    const marginalA = stratumCells.filter((cell) =>
      categorySet(cell).has(categoryA),
    ).length;
    const marginalB = stratumCells.filter((cell) =>
      categorySet(cell).has(categoryB),
    ).length;
    return {
      moments: hypergeometricMoments(stratumCells.length, marginalA, marginalB),
      pmf: hypergeometricPmf(stratumCells.length, marginalA, marginalB),
    };
  });
  const meanExpectedJointCells = stratumNulls.reduce(
    (sum, { moments }) => sum + moments.expectation,
    0,
  );
  const varianceJointCells = stratumNulls.reduce(
    (sum, { moments }) => sum + moments.variance,
    0,
  );
  let distribution = [1];
  let transitionCount = 0;
  for (const { pmf } of stratumNulls) {
    const support = pmf
      .map((probability, overlap) => ({ probability, overlap }))
      .filter(({ probability }) => probability > 0);
    const nextLength = distribution.length + pmf.length - 1;
    transitionCount += distribution.length * support.length;
    if (nextLength > maximumStates || transitionCount > maximumTransitions) {
      return {
        rawPValue: null,
        conservativePValue: null,
        meanExpectedJointCells,
        varianceJointCells,
        stateCount: distribution.length,
        transitionCount,
        normalizationError: null,
        reason: `Exact null exceeded its computation cap (${maximumStates} states or ${maximumTransitions} transitions).`,
      };
    }
    const next = Array.from({ length: nextLength }, () => 0);
    for (let prior = 0; prior < distribution.length; prior += 1) {
      for (const entry of support) {
        next[prior + entry.overlap] += distribution[prior]! * entry.probability;
      }
    }
    distribution = next;
  }
  const totalProbability = distribution.reduce(
    (sum, probability) => sum + probability,
    0,
  );
  const normalizationError = Math.abs(1 - totalProbability);
  if (
    !Number.isFinite(totalProbability) ||
    totalProbability <= 0 ||
    normalizationError > 1e-9
  ) {
    return {
      rawPValue: null,
      conservativePValue: null,
      meanExpectedJointCells,
      varianceJointCells,
      stateCount: distribution.length,
      transitionCount,
      normalizationError,
      reason: "Exact null probability normalization exceeded 1e-9.",
    };
  }
  const rawPValue =
    distribution
      .slice(observedJointCells)
      .reduce((sum, probability) => sum + probability, 0) / totalProbability;
  return {
    rawPValue,
    conservativePValue: Math.min(1, rawPValue + EXACT_NULL_EPSILON),
    meanExpectedJointCells,
    varianceJointCells,
    stateCount: distribution.length,
    transitionCount,
    normalizationError,
    reason: null,
  };
}

export function holmAdjust(pValues: readonly number[]): number[] {
  if (
    pValues.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new Error("Holm p-values must be finite values in [0,1].");
  }
  const ordered = pValues
    .map((value, index) => ({ value, index }))
    .sort(
      (left, right) => left.value - right.value || left.index - right.index,
    );
  const adjusted = Array.from({ length: pValues.length }, () => 1);
  let runningMaximum = 0;
  ordered.forEach((entry, rank) => {
    runningMaximum = Math.max(
      runningMaximum,
      Math.min(1, (pValues.length - rank) * entry.value),
    );
    adjusted[entry.index] = runningMaximum;
  });
  return adjusted;
}

function rankDiscoveryPairs(
  cells: readonly DiscoveryCell[],
  eligibleCategories: readonly string[],
): {
  readonly passingCount: number;
  readonly passingPairs: readonly RankedDiscoveryPair[];
} {
  const categoryIndex = new Map(
    eligibleCategories.map((category, index) => [category, index]),
  );
  const categoryCount = eligibleCategories.length;
  const matrixSize = categoryCount * categoryCount;
  const marginals = new Uint32Array(categoryCount);
  const joints = new Uint32Array(matrixSize);
  const expectations = new Float64Array(matrixSize);
  const variances = new Float64Array(matrixSize);
  const strata = new Map<string, { size: number; marginals: Uint16Array }>();
  for (const cell of cells) {
    const present = [
      ...new Set(
        cell.categories
          .map((category) => categoryIndex.get(category))
          .filter((index): index is number => index !== undefined),
      ),
    ].sort((left, right) => left - right);
    for (const index of present) marginals[index] += 1;
    for (let left = 0; left < present.length; left += 1) {
      for (let right = left + 1; right < present.length; right += 1) {
        joints[present[left]! * categoryCount + present[right]!] += 1;
      }
    }
    const stratumId = discoveryStratumId(cell);
    let stratum = strata.get(stratumId);
    if (stratum === undefined) {
      stratum = {
        size: 0,
        marginals: new Uint16Array(categoryCount),
      };
      strata.set(stratumId, stratum);
    }
    stratum.size += 1;
    for (const index of present) stratum.marginals[index] += 1;
  }
  for (const stratum of strata.values()) {
    const present = Array.from(stratum.marginals, (count, index) => ({
      count,
      index,
    })).filter(({ count }) => count > 0);
    for (let left = 0; left < present.length; left += 1) {
      for (let right = left + 1; right < present.length; right += 1) {
        const categoryA = present[left]!;
        const categoryB = present[right]!;
        const matrixIndex = categoryA.index * categoryCount + categoryB.index;
        const moments = hypergeometricMoments(
          stratum.size,
          categoryA.count,
          categoryB.count,
        );
        expectations[matrixIndex] += moments.expectation;
        variances[matrixIndex] += moments.variance;
      }
    }
  }
  const candidates: PairCounts[] = [];
  for (
    let leftIndex = 0;
    leftIndex < eligibleCategories.length;
    leftIndex += 1
  ) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < eligibleCategories.length;
      rightIndex += 1
    ) {
      const matrixIndex = leftIndex * categoryCount + rightIndex;
      const jointCells = joints[matrixIndex]!;
      const cellsWithCategoryA = marginals[leftIndex]!;
      const cellsWithCategoryB = marginals[rightIndex]!;
      const rawLift =
        cellsWithCategoryA === 0 || cellsWithCategoryB === 0
          ? null
          : (jointCells * cells.length) /
            (cellsWithCategoryA * cellsWithCategoryB);
      const expectation = expectations[matrixIndex]!;
      const variance = variances[matrixIndex]!;
      const pair: PairCounts = {
        categoryA: eligibleCategories[leftIndex]!,
        categoryB: eligibleCategories[rightIndex]!,
        cellsWithCategoryA,
        cellsWithCategoryB,
        jointCells,
        rawLift,
        expectation,
        variance,
        zScore:
          variance === 0
            ? null
            : (jointCells - expectation) / Math.sqrt(variance),
        zeroVarianceExcess: variance === 0 && jointCells > expectation,
      };
      if (
        pair.jointCells >= DISCOVERY_MIN_JOINT_CELLS &&
        pair.rawLift !== null &&
        pair.rawLift >= DISCOVERY_MIN_RAW_LIFT
      ) {
        candidates.push(pair);
      }
    }
  }
  candidates.sort((left, right) => {
    const leftScore =
      left.zScore === null && left.jointCells > left.expectation
        ? Number.POSITIVE_INFINITY
        : (left.zScore ?? Number.NEGATIVE_INFINITY);
    const rightScore =
      right.zScore === null && right.jointCells > right.expectation
        ? Number.POSITIVE_INFINITY
        : (right.zScore ?? Number.NEGATIVE_INFINITY);
    return (
      rightScore - leftScore ||
      left.categoryA.localeCompare(right.categoryA) ||
      left.categoryB.localeCompare(right.categoryB)
    );
  });
  return {
    passingCount: candidates.length,
    passingPairs: candidates.map((pair, index) => ({
      ...pair,
      rank: index + 1,
    })),
  };
}

async function evaluateDiscoveryPairSemantics(
  discoveryPairs: readonly RankedDiscoveryPair[],
  eligibleCategoryIds: readonly string[],
  categories: ReadonlyMap<string, DiscoveryCategory>,
  runtime: PlaceColocationEmbeddingRuntime,
  abortSignal?: AbortSignal,
): Promise<{
  readonly evidence: readonly SemanticFrontierEvidence[];
  readonly failureReason: string | null;
  readonly uniqueCategories: number;
  readonly referencePairs: number;
  readonly evaluatedPairs: number;
  readonly corpusDigest: string | null;
  readonly distributionDigest: string | null;
  readonly spatialDigest: string | null;
  readonly distributionSummary: DiscoveryEngineResult["semanticAudit"]["referenceDistribution"]["summary"];
}> {
  const uniqueIds = [...eligibleCategoryIds].sort();
  const emptySummary = {
    minimum: null,
    p20: null,
    p50: null,
    p80: null,
    p90: null,
    p95: null,
    maximum: null,
  } as const;
  const glosses = new Map<string, string>();
  for (const id of uniqueIds) {
    const category = categories.get(id);
    const gloss = buildCategorySemanticGloss(
      id,
      category?.hierarchy.path ?? null,
    );
    if (gloss !== null) glosses.set(id, gloss);
  }
  const baseSemantic = {
    formula: "clamp(1 - cosineSimilarity(vectorA, vectorB), 0, 1)",
    version: SEMANTIC_DISTANCE_VERSION,
    provider: runtime.provider,
    model: runtime.model,
    glossVersion: SEMANTIC_GLOSS_VERSION,
    timeoutMilliseconds: SEMANTIC_EMBEDDING_TIMEOUT_MS,
    minimumDistance: MIN_SEMANTIC_DISTANCE,
    minimumPercentile: MIN_SEMANTIC_PERCENTILE,
    guardVersion: SEMANTIC_GUARD_VERSION,
  } as const;
  if (uniqueIds.length === 0) {
    return {
      evidence: [],
      failureReason: null,
      uniqueCategories: 0,
      referencePairs: 0,
      evaluatedPairs: 0,
      corpusDigest: null,
      distributionDigest: null,
      spatialDigest: null,
      distributionSummary: emptySummary,
    };
  }
  if (glosses.size !== uniqueIds.length) {
    const reason =
      "An eligible category lacks a canonical hierarchy gloss; semantic evaluation failed closed.";
    return {
      evidence: [],
      failureReason: reason,
      uniqueCategories: uniqueIds.length,
      referencePairs: 0,
      evaluatedPairs: 0,
      corpusDigest: null,
      distributionDigest: null,
      spatialDigest: null,
      distributionSummary: emptySummary,
    };
  }
  if (!runtime.available) {
    const reason = "No embedding provider is available.";
    return {
      evidence: [],
      failureReason: reason,
      uniqueCategories: uniqueIds.length,
      referencePairs: 0,
      evaluatedPairs: 0,
      corpusDigest: null,
      distributionDigest: null,
      spatialDigest: null,
      distributionSummary: emptySummary,
    };
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
    const orderedGlosses = uniqueIds.map((id) => glosses.get(id)!);
    // One logical, canonical-order call embeds every eligible category
    // exactly once. AI SDK embedMany applies each model's maxEmbeddingsPerCall
    // chunking internally while preserving result order and the abort signal.
    const results = await runtime.embedMany(orderedGlosses, {
      abortSignal: combinedSignal,
    });
    if (
      results.length !== orderedGlosses.length ||
      results.some((result, index) => result.text !== orderedGlosses[index])
    ) {
      throw new Error(
        "Embedding results did not preserve canonical gloss order.",
      );
    }
    const vectors = new Map<string, SemanticVector>();
    uniqueIds.forEach((id, index) => {
      const result = results[index]!;
      vectors.set(id, {
        gloss: glosses.get(id)!,
        vector: result.embedding,
        vectorHash: hashEmbeddingVector(result.embedding),
      });
    });
    const corpusDigest = computeSemanticCorpusDigest(
      uniqueIds.map((id) => ({
        id,
        gloss: vectors.get(id)!.gloss,
        vectorHash: vectors.get(id)!.vectorHash,
      })),
      runtime.provider,
      runtime.model,
    );
    const referencePairs: Array<{
      readonly categoryA: string;
      readonly categoryB: string;
      readonly vectorA: SemanticVector;
      readonly vectorB: SemanticVector;
      readonly distance: number;
      percentileNumerator?: number;
    }> = [];
    for (let left = 0; left < uniqueIds.length; left += 1) {
      for (let right = left + 1; right < uniqueIds.length; right += 1) {
        const categoryA = uniqueIds[left]!;
        const categoryB = uniqueIds[right]!;
        const vectorA = vectors.get(categoryA)!;
        const vectorB = vectors.get(categoryB)!;
        referencePairs.push({
          categoryA,
          categoryB,
          vectorA,
          vectorB,
          distance: computeEmbeddingCosineDistance(
            vectorA.vector,
            vectorB.vector,
          ),
        });
      }
    }
    const sortedDistances = referencePairs
      .map(({ distance }) => distance)
      .sort((left, right) => left - right);
    const byPair = new Map<string, (typeof referencePairs)[number]>();
    for (const pair of referencePairs) {
      pair.percentileNumerator = inclusiveEmpiricalPercentile(
        sortedDistances,
        pair.distance,
      ).numerator;
      byPair.set(`${pair.categoryA}\u0000${pair.categoryB}`, pair);
    }
    const ledgerEntry = (
      pair: (typeof referencePairs)[number],
    ): SemanticLedgerEntry => ({
      categoryA: pair.categoryA,
      categoryB: pair.categoryB,
      provider: runtime.provider,
      model: runtime.model,
      vectorHashA: pair.vectorA.vectorHash,
      vectorHashB: pair.vectorB.vectorHash,
      distance: pair.distance,
      inclusiveCdfNumerator: pair.percentileNumerator!,
      referencePairCount: referencePairs.length,
    });
    const distributionDigest = computeSemanticLedgerDigest(
      referencePairs.map(ledgerEntry),
    );
    const evidence = discoveryPairs.map((pair) => {
      const reference = byPair.get(`${pair.categoryA}\u0000${pair.categoryB}`)!;
      const vectorA = vectors.get(pair.categoryA)!;
      const vectorB = vectors.get(pair.categoryB)!;
      const empiricalPercentile =
        referencePairs.length === 0
          ? 0
          : reference.percentileNumerator! / referencePairs.length;
      return {
        rank: pair.rank,
        discoveryRank: pair.rank,
        categoryA: categories.get(pair.categoryA)!,
        categoryB: categories.get(pair.categoryB)!,
        discovery: pair,
        semantic: {
          ...baseSemantic,
          value: reference.distance,
          reason: null,
          empiricalPercentile,
          referencePairCount: referencePairs.length,
          passed: passesCalibratedSemanticGuard(
            reference.distance,
            empiricalPercentile,
          ),
          glossInputs: {
            categoryA: vectorA.gloss,
            categoryB: vectorB.gloss,
          },
          vectorHashes: {
            encoding: VECTOR_HASH_ENCODING,
            categoryA: vectorA.vectorHash,
            categoryB: vectorB.vectorHash,
          },
          dimensions: vectorA.vector.length,
        },
      };
    });
    const spatialDigest = computeSemanticLedgerDigest(
      discoveryPairs.map((pair) =>
        ledgerEntry(byPair.get(`${pair.categoryA}\u0000${pair.categoryB}`)!),
      ),
    );
    return {
      evidence,
      failureReason: null,
      uniqueCategories: uniqueIds.length,
      referencePairs: referencePairs.length,
      evaluatedPairs: evidence.length,
      corpusDigest,
      distributionDigest,
      spatialDigest,
      distributionSummary: {
        minimum: nearestRankQuantile(sortedDistances, 0),
        p20: nearestRankQuantile(sortedDistances, 0.2),
        p50: nearestRankQuantile(sortedDistances, 0.5),
        p80: nearestRankQuantile(sortedDistances, 0.8),
        p90: nearestRankQuantile(sortedDistances, 0.9),
        p95: nearestRankQuantile(sortedDistances, 0.95),
        maximum: nearestRankQuantile(sortedDistances, 1),
      },
    };
  } catch (error) {
    const reason = timeoutController.signal.aborted
      ? `Semantic embedding exceeded the ${SEMANTIC_EMBEDDING_TIMEOUT_MS / 1000}-second timeout.`
      : `Semantic embedding failed: ${boundedReason(error)}`;
    return {
      evidence: [],
      failureReason: reason,
      uniqueCategories: uniqueIds.length,
      referencePairs: 0,
      evaluatedPairs: 0,
      corpusDigest: null,
      distributionDigest: null,
      spatialDigest: null,
      distributionSummary: emptySummary,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverCandidateFamilyFromCells(
  cells: readonly DiscoveryCell[],
  categoryEvidence: ReadonlyMap<string, DiscoveryCategory>,
  seed: string,
  runtime: PlaceColocationEmbeddingRuntime,
  abortSignal?: AbortSignal,
): Promise<DiscoveryEngineResult> {
  assertOccupiedCellLimit(cells.length);
  const fullMarginals = occupiedMarginals(cells);
  const eligibleCategories = [...fullMarginals.entries()]
    .filter(([, cellIds]) => cellIds.size >= MIN_ELIGIBLE_CATEGORY_CELLS)
    .map(([category]) => category)
    .sort();
  if (eligibleCategories.length > MAX_ELIGIBLE_CATEGORIES) {
    throw new Error(
      `Discovery refused: ${eligibleCategories.length} eligible categories exceeds the hard cap of ${MAX_ELIGIBLE_CATEGORIES}; no category was truncated.`,
    );
  }
  const declaredPairFrontier =
    eligibleCategories.length < 2
      ? 0
      : (eligibleCategories.length * (eligibleCategories.length - 1)) / 2;
  if (declaredPairFrontier > MAX_PAIR_FRONTIER) {
    throw new Error(
      `Discovery refused: ${declaredPairFrontier} pairs exceeds the declared frontier cap of ${MAX_PAIR_FRONTIER}.`,
    );
  }
  const split = splitDiscoveryCells(cells, seed);
  const ranked = rankDiscoveryPairs(split.discovery, eligibleCategories);
  const embedded = await evaluateDiscoveryPairSemantics(
    ranked.passingPairs,
    eligibleCategories,
    categoryEvidence,
    runtime,
    abortSignal,
  );
  const semanticPassing = embedded.evidence.filter(
    (entry) => entry.semantic.passed,
  );
  const semanticFrontier = semanticPassing
    .slice(0, MAX_SEMANTIC_FRONTIER)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  const declaredValidationFamily = semanticFrontier.slice(
    0,
    MAX_VALIDATION_FAMILY,
  );
  const preliminaryValidation = declaredValidationFamily.map((entry) => {
    const validationCounts = countPair(
      split.validation,
      entry.categoryA.id,
      entry.categoryB.id,
    );
    const exactNull = exactStratifiedHypergeometricNull(
      split.validation,
      entry.categoryA.id,
      entry.categoryB.id,
      validationCounts.jointCells,
    );
    const fullCounts = countPair(cells, entry.categoryA.id, entry.categoryB.id);
    return { entry, validationCounts, exactNull, fullCounts };
  });
  const holmInputs = preliminaryValidation.map(
    ({ exactNull }) => exactNull.conservativePValue ?? 1,
  );
  const holmAdjusted = holmAdjust(holmInputs);
  const magnitudeFloor = Math.max(
    FULL_MIN_JOINT_CELLS,
    Math.ceil(FULL_MIN_OCCUPIED_FRACTION * cells.length),
  );
  const validationFamily = preliminaryValidation.map((item, index) => ({
    discoveryRank: item.entry.discoveryRank,
    categoryA: item.entry.categoryA,
    categoryB: item.entry.categoryB,
    semantic: item.entry.semantic,
    validation: {
      ...item.validationCounts,
      null: {
        ...item.exactNull,
        version: DISCOVERY_EXACT_NULL_VERSION,
        conditionedLift:
          item.exactNull.meanExpectedJointCells === 0
            ? null
            : item.validationCounts.jointCells /
              item.exactNull.meanExpectedJointCells,
        holmInputPValue: holmInputs[index]!,
        holmAdjustedPValue: holmAdjusted[index]!,
        holmFamilySize: preliminaryValidation.length,
      },
      guards: {
        jointMinimum: VALIDATION_MIN_JOINT_CELLS,
        rawLiftMinimum: VALIDATION_MIN_RAW_LIFT,
        jointPassed:
          item.validationCounts.jointCells >= VALIDATION_MIN_JOINT_CELLS,
        rawLiftPassed:
          item.validationCounts.rawLift !== null &&
          item.validationCounts.rawLift >= VALIDATION_MIN_RAW_LIFT,
      },
    },
    fullUniverse: {
      ...item.fullCounts,
      magnitudeFloor,
      guards: {
        jointPassed: item.fullCounts.jointCells >= magnitudeFloor,
        rawLiftPassed:
          item.fullCounts.rawLift !== null &&
          item.fullCounts.rawLift >= DISCOVERY_MIN_RAW_LIFT,
        rawLiftMinimum: DISCOVERY_MIN_RAW_LIFT,
      },
    },
  }));
  const emptyReason =
    embedded.failureReason ??
    (eligibleCategories.length < 2
      ? "Fewer than two categories meet the full-universe marginal floor."
      : ranked.passingPairs.length === 0
        ? "No discovery-half pair met the joint-cell and raw-lift guards."
        : semanticPassing.length === 0
          ? "No discovery-guard-passing pair met the semantic-distance guard."
          : null);
  return {
    census: {
      occupiedCells: cells.length,
      eligibleCategories: eligibleCategories.length,
      declaredPairFrontier,
      discoveryGuardPassingPairs: ranked.passingCount,
      semanticUniqueCategories: embedded.uniqueCategories,
      semanticReferencePairs: embedded.referencePairs,
      semanticEvaluatedPairs: embedded.evaluatedPairs,
      semanticFrontierPairs: semanticFrontier.length,
      semanticPassingPairs: semanticPassing.length,
      validationFamilyPairs: validationFamily.length,
    },
    split: {
      version: DISCOVERY_SPLIT_VERSION,
      discoveryCells: split.discovery.length,
      validationCells: split.validation.length,
      discoveryFraction:
        cells.length === 0 ? 0 : split.discovery.length / cells.length,
      absoluteCellImbalance: Math.abs(
        split.discovery.length - split.validation.length,
      ),
      strata: split.strata,
      discoveryStrata: split.discoveryStrata,
      validationStrata: split.validationStrata,
      singletonStrata: split.singletonStrata,
      maximumWithinStratumImbalance: split.maximumWithinStratumImbalance,
      seed,
    },
    semanticFrontier,
    semanticAudit: {
      guardVersion: SEMANTIC_GUARD_VERSION,
      percentileMeaning:
        "Inclusive empirical percentile of raw cosine distance relative to every eligible unordered category pair for this county, release, provider/model, and gloss method. It measures relative semantic distance, not statistical improbability or a publish decision.",
      corpus: {
        version: SEMANTIC_CORPUS_DIGEST_VERSION,
        encoding: SEMANTIC_CORPUS_DIGEST_ENCODING,
        digest: embedded.corpusDigest,
        eligibleCategories: embedded.uniqueCategories,
      },
      referenceDistribution: {
        version: SEMANTIC_DISTRIBUTION_DIGEST_VERSION,
        encoding: SEMANTIC_DISTRIBUTION_DIGEST_ENCODING,
        digest: embedded.distributionDigest,
        pairCount: embedded.referencePairs,
        percentileMethod:
          "inclusive empirical CDF: count(referenceDistance <= pairDistance) / referencePairCount; exact numeric ties receive the same highest inclusive rank",
        quantileMethod:
          "nearest-rank quantile over ascending exact numeric distances: sorted[ceil(p*N)-1], with p=0 minimum and p=1 maximum",
        summary: embedded.distributionSummary,
      },
      spatialLedger: {
        version: SEMANTIC_LEDGER_DIGEST_VERSION,
        encoding: SEMANTIC_LEDGER_DIGEST_ENCODING,
        digest: embedded.spatialDigest,
        entries: embedded.evaluatedPairs,
      },
    },
    validationFamily,
    emptyReason,
  };
}

async function readDiscoveryPreflight(
  connection: DuckDBConnection,
  countyKey: string,
  abortSignal?: AbortSignal,
): Promise<DiscoveryPreflight> {
  const predicate = buildPlacePredicate(countyKey, {
    hostedService: "exclude",
  });
  const rows = await readPlaceRows(
    connection,
    `SELECT
       count(*) AS total_filtered_places,
       count(*) FILTER (WHERE ${VALID_COORDINATE_SQL}) AS valid_coordinate_places,
       min(latitude) FILTER (WHERE ${VALID_COORDINATE_SQL}) AS min_latitude,
       max(latitude) FILTER (WHERE ${VALID_COORDINATE_SQL}) AS max_latitude,
       min(overture_release) AS minimum_release,
       max(overture_release) AS maximum_release,
       count(DISTINCT overture_release) AS distinct_release_count,
       count(*) FILTER (WHERE overture_release IS NULL) AS null_release_count
     FROM ${PLACES_VIEW}
     WHERE ${predicate.sql}`,
    [...predicate.params],
    {
      timeoutMs: DISCOVERY_QUERY_TIMEOUT_MS,
      abortSignal,
    },
  );
  const row = rows[0] ?? {};
  return {
    totalFilteredPlaces: countValue(row.total_filtered_places),
    validCoordinatePlaces: countValue(row.valid_coordinate_places),
    minLatitude: numberValue(row.min_latitude),
    maxLatitude: numberValue(row.max_latitude),
    minimumRelease:
      row.minimum_release == null ? null : String(row.minimum_release),
    maximumRelease:
      row.maximum_release == null ? null : String(row.maximum_release),
    distinctReleaseCount: countValue(row.distinct_release_count),
    nullReleaseCount: countValue(row.null_release_count),
  };
}

function releaseIdentity(
  preflight: DiscoveryPreflight,
  immutablePlacesTable: ImmutablePlacesTableProvenance,
): string {
  return [
    `min=${preflight.minimumRelease ?? "null"}`,
    `max=${preflight.maximumRelease ?? "null"}`,
    `distinct=${preflight.distinctReleaseCount}`,
    `nullRows=${preflight.nullReleaseCount}`,
    `immutableStatus=${immutablePlacesTable.status}`,
    `rootCid=${immutablePlacesTable.rootCid ?? "null"}`,
    `contentCid=${immutablePlacesTable.contentCid ?? "null"}`,
    `tableIdentityDigest=${immutablePlacesTable.identityDigest ?? "null"}`,
  ].join(";");
}

export async function readDiscoveryAggregates(
  connection: DuckDBConnection,
  countyKey: string,
  grid: GridDefinition,
  abortSignal?: AbortSignal,
): Promise<{
  readonly cells: DiscoveryCell[];
  readonly categories: Map<string, DiscoveryCategory>;
}> {
  const predicate = buildPlacePredicate(countyKey, {
    hostedService: "exclude",
  });
  const params = [
    ...predicate.params,
    grid.latitudeStepDegrees,
    grid.longitudeStepDegrees,
  ];
  const latitudeStep = `$${params.length - 1}`;
  const longitudeStep = `$${params.length}`;
  const rows = await readPlaceRows(
    connection,
    `WITH valid_places AS MATERIALIZED (
    SELECT
      CAST(floor((latitude + 90) / ${latitudeStep}) AS BIGINT) AS latitude_index,
      CAST(floor((longitude + 180) / ${longitudeStep}) AS BIGINT) AS longitude_index,
      taxonomy_primary,
      CASE
        WHEN taxonomy_hierarchy IS NULL OR trim(taxonomy_hierarchy) = ''
          THEN NULL
        ELSE lower(trim(taxonomy_hierarchy))
      END AS hierarchy_path
    FROM ${PLACES_VIEW}
    WHERE ${predicate.sql}
      AND ${VALID_COORDINATE_SQL}
  ),
  cell_density AS (
    SELECT latitude_index, longitude_index, count(*) AS density
    FROM valid_places
    GROUP BY latitude_index, longitude_index
  ),
  occupancy AS (
    SELECT DISTINCT latitude_index, longitude_index, taxonomy_primary
    FROM valid_places
    WHERE taxonomy_primary IS NOT NULL AND trim(taxonomy_primary) <> ''
  ),
  eligible_categories AS (
    SELECT taxonomy_primary AS category_id, count(*) AS occupied_cell_count
    FROM occupancy
    GROUP BY taxonomy_primary
    HAVING count(*) >= ${MIN_ELIGIBLE_CATEGORY_CELLS}
  ),
  eligible_incidence AS (
    SELECT o.latitude_index, o.longitude_index,
           o.taxonomy_primary AS category_id
    FROM occupancy o
    INNER JOIN eligible_categories e
      ON e.category_id = o.taxonomy_primary
  ),
  path_counts AS (
    SELECT v.taxonomy_primary AS category_id,
           v.hierarchy_path AS path,
           count(*) AS support_count
    FROM valid_places v
    INNER JOIN eligible_categories e
      ON e.category_id = v.taxonomy_primary
    WHERE v.hierarchy_path IS NOT NULL
    GROUP BY v.taxonomy_primary, v.hierarchy_path
  ),
  modal_support AS (
    SELECT *,
           max(support_count) OVER (PARTITION BY category_id) AS maximum_support
    FROM path_counts
  ),
  modal_summary AS (
    SELECT category_id,
           min(path) FILTER (WHERE support_count = maximum_support) AS path,
           max(maximum_support) AS support_count,
           count(*) FILTER (WHERE support_count = maximum_support) - 1 AS ambiguity_count
    FROM modal_support
    GROUP BY category_id
  ),
  category_counts AS (
    SELECT v.taxonomy_primary AS category_id,
           count(*) AS coordinate_count
    FROM valid_places v
    INNER JOIN eligible_categories e
      ON e.category_id = v.taxonomy_primary
    GROUP BY v.taxonomy_primary
  ),
  summary AS (
    SELECT
      (SELECT count(*) FROM cell_density) AS occupied_cells,
      (SELECT count(*) FROM eligible_categories) AS eligible_category_count
  )
  SELECT
    'summary' AS record_type,
    NULL::BIGINT AS latitude_index,
    NULL::BIGINT AS longitude_index,
    NULL::BIGINT AS density,
    NULL::VARCHAR AS category_id,
    NULL::VARCHAR AS hierarchy_path,
    NULL::BIGINT AS support_count,
    NULL::BIGINT AS coordinate_count,
    NULL::BIGINT AS ambiguity_count,
    occupied_cells,
    eligible_category_count
  FROM summary
  UNION ALL
  SELECT
    'cell' AS record_type,
    d.latitude_index,
    d.longitude_index,
    d.density,
    i.category_id,
    NULL::VARCHAR AS hierarchy_path,
    NULL::BIGINT AS support_count,
    NULL::BIGINT AS coordinate_count,
    NULL::BIGINT AS ambiguity_count,
    NULL::BIGINT AS occupied_cells,
    NULL::BIGINT AS eligible_category_count
  FROM cell_density d
  LEFT JOIN eligible_incidence i
    USING (latitude_index, longitude_index)
  UNION ALL
  SELECT
    'category' AS record_type,
    NULL::BIGINT AS latitude_index,
    NULL::BIGINT AS longitude_index,
    NULL::BIGINT AS density,
    c.category_id,
    m.path AS hierarchy_path,
    coalesce(m.support_count, 0) AS support_count,
    c.coordinate_count,
    coalesce(m.ambiguity_count, 0) AS ambiguity_count,
    NULL::BIGINT AS occupied_cells,
    NULL::BIGINT AS eligible_category_count
  FROM category_counts c
  LEFT JOIN modal_summary m USING (category_id)
  ORDER BY record_type, latitude_index, longitude_index, category_id`,
    [...params],
    {
      timeoutMs: DISCOVERY_QUERY_TIMEOUT_MS,
      abortSignal,
    },
  );
  const summary = rows.find((row) => row.record_type === "summary");
  const occupiedCells = countValue(summary?.occupied_cells);
  const eligibleCategoryCount = countValue(summary?.eligible_category_count);
  assertOccupiedCellLimit(occupiedCells);
  if (eligibleCategoryCount > MAX_ELIGIBLE_CATEGORIES) {
    throw new Error(
      `Discovery refused: ${eligibleCategoryCount} eligible categories exceeds the hard cap of ${MAX_ELIGIBLE_CATEGORIES}; no category was truncated.`,
    );
  }
  const cells = new Map<string, DiscoveryCell & { categories: string[] }>();
  for (const row of rows.filter(
    (candidate) => candidate.record_type === "cell",
  )) {
    const latitudeIndex = countValue(row.latitude_index);
    const longitudeIndex = countValue(row.longitude_index);
    const cellId = `${latitudeIndex}:${longitudeIndex}`;
    let cell = cells.get(cellId);
    if (cell === undefined) {
      cell = {
        cellId,
        latitudeIndex,
        longitudeIndex,
        density: countValue(row.density),
        categories: [],
      };
      cells.set(cellId, cell);
    }
    if (row.category_id != null) {
      cell.categories.push(String(row.category_id));
    }
  }
  const result = new Map<string, DiscoveryCategory>();
  for (const row of rows.filter(
    (candidate) => candidate.record_type === "category",
  )) {
    const categoryId = String(row.category_id ?? "");
    const supportCount = countValue(row.support_count);
    const coordinateCount = countValue(row.coordinate_count);
    result.set(categoryId, {
      id: categoryId,
      label: categoryId.replaceAll("_", " "),
      hierarchy: {
        path: row.hierarchy_path == null ? null : String(row.hierarchy_path),
        supportCount,
        coverage: coordinateCount === 0 ? null : supportCount / coordinateCount,
        ambiguityCount: countValue(row.ambiguity_count),
      },
    });
  }
  if (cells.size !== occupiedCells || result.size !== eligibleCategoryCount) {
    throw new Error(
      "Discovery aggregate loader returned inconsistent cell/category summary counts.",
    );
  }
  return { cells: [...cells.values()], categories: result };
}

function defaultEmbeddingRuntime(): PlaceColocationEmbeddingRuntime {
  return {
    available: true,
    provider: getEmbeddingProvider(),
    model: getActiveEmbeddingModel(),
    embedMany: embedManyTexts as (
      texts: string[],
      options?: { readonly abortSignal?: AbortSignal },
    ) => Promise<EmbeddingResult[]>,
  };
}

export async function runPlaceColocationDiscovery(
  request: PlaceColocationDiscoveryRequest,
  options: {
    readonly embedding?: PlaceColocationEmbeddingRuntime;
    readonly abortSignal?: AbortSignal;
  } = {},
): Promise<PlaceColocationDiscoveryEvidence> {
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
  const provenancePromise = getPlaceProvenance(
    catalogDataset,
    immutablePlacesTable,
  );
  const { preflight, grid, cells, categories } = await withPlaceConnection(
    dataset,
    async (connection) => {
      const preflightStartedAt = performance.now();
      let preflight: DiscoveryPreflight;
      try {
        preflight = await readDiscoveryPreflight(
          connection,
          dataset.countyKey,
          options.abortSignal,
        );
      } catch (error) {
        throw new Error(`Discovery preflight failed: ${boundedReason(error)}`);
      }
      logger.info(
        {
          county: dataset.countyKey,
          elapsedMilliseconds: Math.round(
            performance.now() - preflightStartedAt,
          ),
        },
        "Completed place discovery preflight",
      );
      assertValidCoordinatePlaceLimit(preflight.validCoordinatePlaces);
      if (
        preflight.validCoordinatePlaces === 0 ||
        !Number.isFinite(preflight.minLatitude) ||
        !Number.isFinite(preflight.maxLatitude)
      ) {
        throw new Error(
          "Discovery requires at least one valid-coordinate place.",
        );
      }
      const grid = computeGridDefinition(
        DEFAULT_GRID_CELL_SIZE_METERS,
        preflight.minLatitude,
        preflight.maxLatitude,
      );
      const aggregateStartedAt = performance.now();
      let aggregates: Awaited<ReturnType<typeof readDiscoveryAggregates>>;
      try {
        aggregates = await readDiscoveryAggregates(
          connection,
          dataset.countyKey,
          grid,
          options.abortSignal,
        );
      } catch (error) {
        throw new Error(
          `Discovery aggregate query failed: ${boundedReason(error)}`,
        );
      }
      logger.info(
        {
          county: dataset.countyKey,
          elapsedMilliseconds: Math.round(
            performance.now() - aggregateStartedAt,
          ),
          occupiedCells: aggregates.cells.length,
          eligibleCategories: aggregates.categories.size,
        },
        "Completed place discovery aggregate load",
      );
      return {
        preflight,
        grid,
        cells: aggregates.cells,
        categories: aggregates.categories,
      };
    },
    {
      connectionTimeoutMs: DISCOVERY_QUERY_TIMEOUT_MS,
      abortSignal: options.abortSignal,
    },
  );
  const identity = releaseIdentity(preflight, immutablePlacesTable);
  const seed = sha256(
    [
      dataset.countyKey,
      dataset.updatedAt,
      dataset.tableUrl,
      identity,
      DISCOVERY_SPLIT_SEED_VERSION,
    ].join("|"),
  );
  const engine = await discoverCandidateFamilyFromCells(
    cells,
    categories,
    seed,
    options.embedding ?? defaultEmbeddingRuntime(),
    options.abortSignal,
  );
  const provenance = await provenancePromise;
  const immutableFailureReason =
    immutablePlacesTable.status === "resolved"
      ? null
      : `Immutable places-table provenance is ${immutablePlacesTable.status}; publication failed closed: ${
          immutablePlacesTable.reason ?? "no immutable identity was established"
        }`;
  const failureReason = [immutableFailureReason, engine.emptyReason]
    .filter((reason): reason is string => reason !== null)
    .join(" ");
  return {
    county: {
      key: dataset.countyKey,
      name: dataset.countyName,
      stateCode: dataset.stateCode,
      fips: dataset.countyFips,
    },
    inputs: { county: request.county.trim() },
    universe: {
      unit: "occupied fixed grid cells",
      hostedService: "exclude",
      totalFilteredPlaces: preflight.totalFilteredPlaces,
      validCoordinatePlaces: preflight.validCoordinatePlaces,
      coordinateCoverage:
        preflight.totalFilteredPlaces === 0
          ? 0
          : preflight.validCoordinatePlaces / preflight.totalFilteredPlaces,
      occupiedCells: cells.length,
    },
    grid,
    provenance: { ...provenance, releaseIdentity: identity },
    seed,
    counts: engine.census,
    caps: {
      maximumValidCoordinatePlaces: MAX_COLOCATION_PLACES,
      maximumOccupiedCells: MAX_COLOCATION_CELLS,
      minimumEligibleCategoryCells: MIN_ELIGIBLE_CATEGORY_CELLS,
      maximumEligibleCategories: MAX_ELIGIBLE_CATEGORIES,
      maximumPairFrontier: MAX_PAIR_FRONTIER,
      maximumSemanticFrontier: MAX_SEMANTIC_FRONTIER,
      maximumValidationFamily: MAX_VALIDATION_FAMILY,
      exactNullMaximumStates: EXACT_NULL_MAX_STATES,
      exactNullMaximumTransitions: EXACT_NULL_MAX_TRANSITIONS,
    },
    guards: {
      discoveryMinimumJointCells: DISCOVERY_MIN_JOINT_CELLS,
      discoveryMinimumRawLift: DISCOVERY_MIN_RAW_LIFT,
      semanticMinimumDistance: MIN_SEMANTIC_DISTANCE,
      semanticMinimumPercentile: MIN_SEMANTIC_PERCENTILE,
      validationMinimumJointCells: VALIDATION_MIN_JOINT_CELLS,
      validationMinimumRawLift: VALIDATION_MIN_RAW_LIFT,
      fullMinimumJointCells: FULL_MIN_JOINT_CELLS,
      fullMinimumOccupiedFraction: FULL_MIN_OCCUPIED_FRACTION,
    },
    split: engine.split,
    semanticAudit: engine.semanticAudit,
    semanticFrontier: engine.semanticFrontier,
    validationFamily: engine.validationFamily,
    failure: {
      failedClosed: failureReason !== "",
      reason: failureReason === "" ? null : failureReason,
      truncated: false,
    },
    method: {
      version: DISCOVERY_METHOD_VERSION,
      grid: GRID_FORMULA_VERSION,
      split: DISCOVERY_SPLIT_VERSION,
      splitSeed: DISCOVERY_SPLIT_SEED_VERSION,
      analyticRanking: DISCOVERY_ANALYTIC_VERSION,
      semanticDistance: SEMANTIC_DISTANCE_VERSION,
      semanticGuard: SEMANTIC_GUARD_VERSION,
      exactNull: DISCOVERY_EXACT_NULL_VERSION,
      holm: DISCOVERY_HOLM_VERSION,
      formulas: {
        discoveryLift: "jointCells * sideOccupiedCells / (cellsA * cellsB)",
        stratifiedExpectation: "sum_s(A_s * B_s / N_s)",
        stratifiedVariance:
          "sum_s[B_s*(A_s/N_s)*(1-A_s/N_s)*((N_s-B_s)/(N_s-1))]",
        zScore:
          "(observedJointCells - stratifiedExpectation) / sqrt(stratifiedVariance)",
        semanticEligibility:
          "Every eligible category is embedded. Every eligible unordered pair defines an outcome-independent reference distribution. A discovery pair passes only when raw cosine distance >= 0.35 AND inclusive full-universe empirical percentile >= 0.80, before the top-32 response cap.",
        exactTail:
          "sum_{j>=observed} convolution_s Hypergeometric(N_s,A_s,B_s)[j], plus conservative epsilon 1e-12",
        holm: "step-down max_{j<=rank} min(1,(familySize-j+1)*orderedP_j); failed exact nulls enter as p=1",
        fullMagnitudeFloor: "max(50, ceil(0.02 * fullUniverseOccupiedCells))",
      },
    },
    rerunContract:
      immutablePlacesTable.status === "resolved"
        ? "Rerun county-only discovery against immutablePlacesTable.immutableTableUrl with the same rootCid, contentCid (when exposed), table identity digest, catalogUpdatedAt, releaseIdentity, 800m grid method, split seed/method, thresholds, caps, embedding provider/model, eligible semantic corpus, full eligible-pair distribution and canonical digest encodings, exact-null bounds, and Holm family definition."
        : "Exact rerun and publication are unavailable because immutable places-table provenance could not be resolved. The mutable placesTableUrl is diagnostic input only and must not be treated as an exact rerun locator.",
    decisionNote:
      "The semantic percentile measures relative category-gloss distance, not statistical improbability. This tool emits no publish decision, no alpha threshold, and no cross-release multiple-testing claim; Watchog owns those controls.",
  };
}
