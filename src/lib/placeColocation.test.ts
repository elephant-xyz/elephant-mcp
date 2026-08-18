import type { DuckDBConnection } from "@duckdb/node-api";
import { describe, expect, it, vi } from "vitest";

import { runWithTimeout } from "./placeQuery.ts";
import {
  MAX_COLOCATION_CELLS,
  MAX_COLOCATION_PLACES,
  assertOccupiedCellLimit,
  assertValidCoordinatePlaceLimit,
  assignGridCell,
  buildCategorySemanticGloss,
  calculateObservedCellStatistics,
  canonicalizeCategoryPair,
  computeEmbeddingCosineDistance,
  computeGlossedSemanticDistance,
  computeGridDefinition,
  computeTaxonomyTreeDistance,
  hashEmbeddingVector,
  runDensityConditionedNullModel,
  selectModalHierarchyPath,
  type GridCellEvidence,
  type PlaceColocationEmbeddingRuntime,
} from "./placeColocation.ts";

function cell(
  latitudeIndex: number,
  longitudeIndex: number,
  options: {
    readonly density?: number;
    readonly categoryA?: boolean;
    readonly categoryB?: boolean;
  } = {},
): GridCellEvidence {
  return {
    cellId: `${latitudeIndex}:${longitudeIndex}`,
    latitudeIndex,
    longitudeIndex,
    density: options.density ?? 1,
    hasCategoryA: options.categoryA ?? false,
    hasCategoryB: options.categoryB ?? false,
  };
}

function embeddingRuntime(
  embedMany: PlaceColocationEmbeddingRuntime["embedMany"],
): PlaceColocationEmbeddingRuntime {
  return {
    available: true,
    provider: "openai",
    model: "test-embedding-model",
    embedMany,
  };
}

describe("place co-location pure statistics", () => {
  it("canonicalizes category pairs lexicographically and rejects equality", () => {
    expect(canonicalizeCategoryPair("restaurant", "nail_salon")).toEqual([
      "nail_salon",
      "restaurant",
    ]);
    expect(canonicalizeCategoryPair("nail_salon", "restaurant")).toEqual([
      "nail_salon",
      "restaurant",
    ]);
    expect(() => canonicalizeCategoryPair("cafe", "cafe")).toThrow(/distinct/);
  });

  it("uses exact equirectangular steps and a stable global origin", () => {
    const grid = computeGridDefinition(800, 26, 28);
    expect(grid.referenceLatitude).toBe(27);
    expect(grid.latitudeStepDegrees).toBe(800 / 111_320);
    expect(grid.longitudeStepDegrees).toBe(
      800 / (111_320 * Math.cos((27 * Math.PI) / 180)),
    );
    expect(grid.originLatitude).toBe(-90);
    expect(grid.originLongitude).toBe(-180);
    expect(assignGridCell(-90, -180, grid)).toEqual({
      latitudeIndex: 0,
      longitudeIndex: 0,
    });
    expect(
      assignGridCell(
        -90 + grid.latitudeStepDegrees * 3.5,
        -180 + grid.longitudeStepDegrees * 4.5,
        grid,
      ),
    ).toEqual({ latitudeIndex: 3, longitudeIndex: 4 });
  });

  it("keeps taxonomy distance as separate auxiliary tree evidence", () => {
    expect(
      computeTaxonomyTreeDistance(
        "dining/restaurant/cafe",
        "dining/restaurant/cafe",
      ),
    ).toBe(0);
    expect(
      computeTaxonomyTreeDistance(
        "dining/restaurant/cafe",
        "dining/restaurant/diner",
      ),
    ).toBeCloseTo(1 / 3);
    expect(
      computeTaxonomyTreeDistance("shopping/nail_salon", "dining/restaurant"),
    ).toBe(1);
    expect(computeTaxonomyTreeDistance(null, "dining/restaurant")).toBeNull();
  });

  it("keeps cosine distance finite for extreme finite vector values", () => {
    expect(
      computeEmbeddingCosineDistance(
        [Number.MAX_VALUE, Number.MAX_VALUE],
        [Number.MAX_VALUE, Number.MAX_VALUE],
      ),
    ).toBeCloseTo(0);
    expect(
      computeEmbeddingCosineDistance(
        [Number.MIN_VALUE, 0],
        [0, Number.MIN_VALUE],
      ),
    ).toBe(1);
  });

  it("builds canonical glosses and separates related from unrelated vectors", async () => {
    const categoryA = {
      id: "marina",
      hierarchyPath: "services/marine_service/marina",
    };
    const categoryB = {
      id: "seafood_restaurant",
      hierarchyPath: "dining/restaurant/seafood_restaurant",
    };
    const glossA = buildCategorySemanticGloss(
      categoryA.id,
      categoryA.hierarchyPath,
    );
    const glossB = buildCategorySemanticGloss(
      categoryB.id,
      categoryB.hierarchyPath,
    );
    expect(glossA).toBe(
      "Overture category label: marina. Full taxonomy hierarchy: services/marine_service/marina.",
    );
    expect(glossB).toBe(
      "Overture category label: seafood restaurant. Full taxonomy hierarchy: dining/restaurant/seafood_restaurant.",
    );

    const relatedEmbed = vi.fn(async (texts: string[]) =>
      texts.map((text, index) => ({
        text,
        embedding: index === 0 ? [1, 0] : [0.9, 0.1],
      })),
    );
    const unrelatedEmbed = vi.fn(async (texts: string[]) =>
      texts.map((text, index) => ({
        text,
        embedding: index === 0 ? [1, 0] : [0, 1],
      })),
    );
    const related = await computeGlossedSemanticDistance(
      categoryA,
      categoryB,
      embeddingRuntime(relatedEmbed),
    );
    const unrelated = await computeGlossedSemanticDistance(
      categoryA,
      categoryB,
      embeddingRuntime(unrelatedEmbed),
    );

    expect(related.value).toBeCloseTo(
      computeEmbeddingCosineDistance([1, 0], [0.9, 0.1]),
    );
    expect(related.value).toBeLessThan(0.01);
    expect(unrelated.value).toBe(1);
    expect(related.reason).toBeNull();
    expect(related.glossInputs).toEqual({
      categoryA: glossA,
      categoryB: glossB,
    });
  });

  it("returns null semantic evidence on embedding failure without a taxonomy fallback", async () => {
    const result = await computeGlossedSemanticDistance(
      {
        id: "fishing_charter",
        hierarchyPath: "services/tourism/fishing_charter",
      },
      {
        id: "marina",
        hierarchyPath: "services/marine_service/marina",
      },
      embeddingRuntime(async () => {
        throw new Error("provider unavailable");
      }),
    );

    expect(result.value).toBeNull();
    expect(result.reason).toBe(
      "Semantic embedding failed: provider unavailable",
    );
    expect(result.vectorHashes.categoryA).toBeNull();
    expect(result.vectorHashes.categoryB).toBeNull();
  });

  it("aborts semantic embedding at the fixed timeout without a dangling race", async () => {
    vi.useFakeTimers();
    try {
      const pending = computeGlossedSemanticDistance(
        {
          id: "fishing_charter",
          hierarchyPath: "services/tourism/fishing_charter",
        },
        {
          id: "marina",
          hierarchyPath: "services/marine_service/marina",
        },
        embeddingRuntime(
          (_texts, options) =>
            new Promise((_resolve, reject) => {
              options?.abortSignal?.addEventListener(
                "abort",
                () => reject(new Error("provider aborted")),
                { once: true },
              );
            }),
        ),
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toMatchObject({
        value: null,
        reason: "Semantic embedding exceeded the 15-second timeout.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("hashes vectors deterministically with canonical binary64 encoding", async () => {
    expect(hashEmbeddingVector([-0, 1])).toBe(hashEmbeddingVector([0, 1]));
    expect(hashEmbeddingVector([1, 2])).toBe(
      "f814737da80b11b6d6e54c254b9d7e711669462c0e53585f776afea6ea073afc",
    );

    const categoryA = {
      id: "marina",
      hierarchyPath: "services/marine_service/marina",
    };
    const categoryB = {
      id: "seafood_restaurant",
      hierarchyPath: "dining/restaurant/seafood_restaurant",
    };
    const runtime = embeddingRuntime(async (texts) =>
      texts.map((text, index) => ({
        text,
        embedding: index === 0 ? [1, 2] : [3, 4],
      })),
    );
    const forward = await computeGlossedSemanticDistance(
      categoryA,
      categoryB,
      runtime,
    );
    const repeated = await computeGlossedSemanticDistance(
      categoryA,
      categoryB,
      runtime,
    );
    expect(repeated).toEqual(forward);
    expect(forward.vectorHashes.categoryA).toBe(hashEmbeddingVector([1, 2]));
    expect(forward.vectorHashes.categoryB).toBe(hashEmbeddingVector([3, 4]));
  });

  it("selects modal paths deterministically and reports tied ambiguity", () => {
    expect(
      selectModalHierarchyPath(
        [
          { path: "shopping/z", supportCount: 2 },
          { path: "shopping/a", supportCount: 2 },
          { path: "shopping/b", supportCount: 1 },
        ],
        8,
      ),
    ).toEqual({
      path: "shopping/a",
      supportCount: 2,
      coverage: 0.25,
      ambiguityCount: 1,
    });
    expect(selectModalHierarchyPath([], 3)).toEqual({
      path: null,
      supportCount: 0,
      coverage: 0,
      ambiguityCount: 0,
    });
  });

  it("uses the occupied-cell universe for expectation and global lift", () => {
    const cells = [
      cell(0, 0, { categoryA: true, categoryB: true }),
      cell(0, 1, { categoryA: true }),
      cell(0, 2, { categoryB: true }),
      cell(0, 3),
    ];
    expect(calculateObservedCellStatistics(cells)).toEqual({
      occupiedCells: 4,
      cellsWithCategoryA: 2,
      cellsWithCategoryB: 2,
      jointCells: 1,
      independenceExpectedJointCells: 1,
      globalLift: 1,
    });
  });

  it("conditions away a density/geography confound with apparent global lift", () => {
    const hot = Array.from({ length: 8 }, (_, index) =>
      cell(0, index, {
        categoryA: index < 6,
        categoryB: index >= 2,
      }),
    );
    const cold = Array.from({ length: 56 }, (_, index) =>
      cell(8 + Math.floor(index / 8), index % 8, {
        categoryA: index === 0,
        categoryB: index === 1,
      }),
    );
    const cells = [...hot, ...cold];
    const observed = calculateObservedCellStatistics(cells);
    const conditioned = runDensityConditionedNullModel(
      cells,
      "density-confound-seed",
      observed.jointCells,
    );

    expect(observed.globalLift).toBeGreaterThan(5);
    expect(conditioned.meanExpectedJointCells).toBeGreaterThan(
      observed.jointCells,
    );
    expect(conditioned.pValue).not.toBeNull();
    expect(conditioned.pValue).toBeGreaterThan(0.05);
    expect(conditioned.densityConditionedLift).toBeLessThan(1);
  });

  it("detects strong within-stratum association deterministically", () => {
    const cells = Array.from({ length: 64 }, (_, index) =>
      cell(Math.floor(index / 8), index % 8, {
        categoryA: index < 16,
        categoryB: index < 16,
      }),
    );
    const observed = calculateObservedCellStatistics(cells);
    const first = runDensityConditionedNullModel(
      cells,
      "association-seed",
      observed.jointCells,
    );
    const second = runDensityConditionedNullModel(
      cells,
      "association-seed",
      observed.jointCells,
    );

    expect(first).toEqual(second);
    expect(first.pValue).toBe(0.005);
    expect(first.densityConditionedLift).toBeGreaterThan(3);
    expect(first.permutableStratumCount).toBe(1);
  });

  it("returns a null p-value and reason when overlap cannot vary", () => {
    const cells = Array.from({ length: 8 }, (_, index) =>
      cell(0, index, {
        categoryA: index < 3,
        categoryB: true,
      }),
    );
    const result = runDensityConditionedNullModel(cells, "fixed-seed", 3);
    expect(result.pValue).toBeNull();
    expect(result.noPermutationReason).toMatch(/No stratum permits/);
    expect(result.permutableStratumCount).toBe(0);
    expect(result.fixedStratumCount).toBe(1);
  });

  it("fails hard limits instead of allowing truncated analysis", () => {
    expect(() =>
      assertValidCoordinatePlaceLimit(MAX_COLOCATION_PLACES),
    ).not.toThrow();
    expect(() =>
      assertValidCoordinatePlaceLimit(MAX_COLOCATION_PLACES + 1),
    ).toThrow(/no places were truncated or analyzed/);
    expect(() => assertOccupiedCellLimit(MAX_COLOCATION_CELLS)).not.toThrow();
    expect(() => assertOccupiedCellLimit(MAX_COLOCATION_CELLS + 1)).toThrow(
      /no cells were truncated or analyzed/,
    );
  });

  it("turns an interrupted place operation into a bounded timeout error", async () => {
    let rejectOperation: ((reason?: unknown) => void) | undefined;
    const connection = {
      interrupt() {
        rejectOperation?.(new Error("interrupted"));
      },
    } as unknown as DuckDBConnection;

    await expect(
      runWithTimeout(
        connection,
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectOperation = reject;
          }),
        5,
      ),
    ).rejects.toThrow(/Places query exceeded the 0.005-second timeout/);
  });

  it("interrupts a running place operation when the caller aborts", async () => {
    let rejectOperation: ((reason?: unknown) => void) | undefined;
    const interrupt = vi.fn(() => {
      rejectOperation?.(new Error("interrupted"));
    });
    const connection = {
      interrupt,
    } as unknown as DuckDBConnection;
    const controller = new AbortController();
    const pending = runWithTimeout(
      connection,
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOperation = reject;
        }),
      10_000,
      controller.signal,
    );

    controller.abort();

    await expect(pending).rejects.toThrow(/aborted during execution/);
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.env.RUN_COLOCATION_BENCHMARK !== "1")(
    "benchmarks the maximum bounded permutation workload",
    () => {
      const cells = Array.from({ length: MAX_COLOCATION_CELLS }, (_, index) =>
        cell(Math.floor(index / 160), index % 160, {
          categoryA: index % 2 === 0,
          categoryB: index % 3 === 0,
        }),
      );
      const observed = calculateObservedCellStatistics(cells);
      const startedAt = performance.now();
      const result = runDensityConditionedNullModel(
        cells,
        "maximum-bound-benchmark-seed",
        observed.jointCells,
      );
      const elapsedMilliseconds = Math.round(performance.now() - startedAt);
      console.info(
        JSON.stringify({
          benchmark: "maximum-bounded-colocation-null-model",
          occupiedCells: cells.length,
          permutations: result.permutations,
          elapsedMilliseconds,
        }),
      );
      expect(result.permutations).toBe(199);
    },
    30_000,
  );
});
