import { describe, expect, it, vi } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";

import {
  assignGridCell,
  computeGridDefinition,
  runDensityConditionedNullModel,
  selectModalHierarchyPath,
  type PlaceColocationEmbeddingRuntime,
} from "./placeColocation.ts";
import {
  EXACT_NULL_EPSILON,
  MAX_ELIGIBLE_CATEGORIES,
  computeSemanticCorpusDigest,
  computeSemanticLedgerDigest,
  discoverCandidateFamilyFromCells,
  exactStratifiedHypergeometricNull,
  holmAdjust,
  hypergeometricMoments,
  hypergeometricPmf,
  inclusiveEmpiricalPercentile,
  nearestRankQuantile,
  passesCalibratedSemanticGuard,
  readDiscoveryAggregates,
  splitDiscoveryCells,
  type DiscoveryCategory,
  type DiscoveryCell,
} from "./placeColocationDiscovery.ts";

function cells(count: number): DiscoveryCell[] {
  return Array.from({ length: count }, (_, index) => ({
    cellId: `${Math.floor(index / 40)}:${index % 40}`,
    latitudeIndex: Math.floor(index / 40),
    longitudeIndex: index % 40,
    density: 1,
    categories: [],
  }));
}

function category(id: string): DiscoveryCategory {
  return {
    id,
    label: id.replaceAll("_", " "),
    hierarchy: {
      path: `root/${id}`,
      supportCount: 50,
      coverage: 1,
      ambiguityCount: 0,
    },
  };
}

function runtime(
  vectors: Readonly<Record<string, readonly number[]>>,
): PlaceColocationEmbeddingRuntime {
  return {
    available: true,
    provider: "openai",
    model: "test-model",
    embedMany: vi.fn(async (glosses: string[]) =>
      glosses.map((text: string) => {
        const id = text.match(/label: ([^.]+)/)?.[1]?.replaceAll(" ", "_");
        return {
          text,
          embedding: [...(vectors[id ?? ""] ?? [1, 0])],
        };
      }),
    ),
  };
}

describe("automatic place co-location discovery", () => {
  it("matches a row-wise reference for incidence, density, modal paths, duplicates, and invalid rows", async () => {
    const grid = computeGridDefinition(800, 26, 26);
    const baseLatitudeIndex = Math.floor((26 + 90) / grid.latitudeStepDegrees);
    const baseLongitudeIndex = Math.floor(
      (-82 + 180) / grid.longitudeStepDegrees,
    );
    type PlaceRow = {
      county: string;
      hosted: boolean;
      latitude: number | null;
      longitude: number | null;
      category: string | null;
      hierarchy: string | null;
    };
    const rows: PlaceRow[] = [];
    const coordinate = (offset: number) => ({
      latitude:
        -90 + (baseLatitudeIndex + offset + 0.5) * grid.latitudeStepDegrees,
      longitude: -180 + (baseLongitudeIndex + 0.5) * grid.longitudeStepDegrees,
    });
    for (let index = 0; index < 60; index += 1) {
      if (index < 50) {
        rows.push({
          county: "lee",
          hosted: false,
          ...coordinate(index),
          category: "alpha",
          hierarchy: index < 25 ? "Root/Z" : "Root/A",
        });
      }
      if (index >= 10) {
        rows.push({
          county: "lee",
          hosted: false,
          ...coordinate(index),
          category: "beta",
          hierarchy: "Root/Beta",
        });
      }
      if (index < 49) {
        rows.push({
          county: "lee",
          hosted: false,
          ...coordinate(index),
          category: "gamma",
          hierarchy: "Root/Gamma",
        });
      }
    }
    rows.push(
      {
        county: "lee",
        hosted: false,
        ...coordinate(0),
        category: "alpha",
        hierarchy: "Root/Z",
      },
      {
        county: "lee",
        hosted: false,
        ...coordinate(49),
        category: "alpha",
        hierarchy: "Root/A",
      },
      {
        county: "lee",
        hosted: true,
        ...coordinate(61),
        category: "alpha",
        hierarchy: "Root/A",
      },
      {
        county: "lee",
        hosted: false,
        latitude: null,
        longitude: -82,
        category: "alpha",
        hierarchy: "Root/A",
      },
      {
        county: "lee",
        hosted: false,
        latitude: 91,
        longitude: -82,
        category: "alpha",
        hierarchy: "Root/A",
      },
      {
        county: "orange",
        hosted: false,
        ...coordinate(62),
        category: "alpha",
        hierarchy: "Root/A",
      },
    );

    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await connection.run(`
        CREATE TABLE places (
          county_key VARCHAR,
          is_hosted_service BOOLEAN,
          latitude DOUBLE,
          longitude DOUBLE,
          taxonomy_primary VARCHAR,
          taxonomy_hierarchy VARCHAR
        )
      `);
      const sqlValue = (value: string | number | boolean | null) => {
        if (value === null) return "NULL";
        if (typeof value === "number" || typeof value === "boolean") {
          return String(value);
        }
        return `'${value.replaceAll("'", "''")}'`;
      };
      await connection.run(
        `INSERT INTO places VALUES ${rows
          .map(
            (row) =>
              `(${[
                row.county,
                row.hosted,
                row.latitude,
                row.longitude,
                row.category,
                row.hierarchy,
              ]
                .map(sqlValue)
                .join(",")})`,
          )
          .join(",")}`,
      );

      const optimized = await readDiscoveryAggregates(connection, "lee", grid);
      const validRows = rows.filter(
        (row) =>
          row.county === "lee" &&
          !row.hosted &&
          row.latitude !== null &&
          row.longitude !== null &&
          Number.isFinite(row.latitude) &&
          Number.isFinite(row.longitude) &&
          row.latitude >= -90 &&
          row.latitude <= 90 &&
          row.longitude >= -180 &&
          row.longitude <= 180,
      );
      const referenceCells = new Map<
        string,
        { density: number; categories: Set<string> }
      >();
      for (const row of validRows) {
        const assigned = assignGridCell(row.latitude!, row.longitude!, grid);
        const cellId = `${assigned.latitudeIndex}:${assigned.longitudeIndex}`;
        const cell = referenceCells.get(cellId) ?? {
          density: 0,
          categories: new Set<string>(),
        };
        cell.density += 1;
        if (row.category !== null) cell.categories.add(row.category);
        referenceCells.set(cellId, cell);
      }
      const categoryCells = new Map<string, Set<string>>();
      for (const [cellId, cell] of referenceCells) {
        for (const categoryId of cell.categories) {
          const occupied = categoryCells.get(categoryId) ?? new Set<string>();
          occupied.add(cellId);
          categoryCells.set(categoryId, occupied);
        }
      }
      const eligible = new Set(
        [...categoryCells]
          .filter(([, occupied]) => occupied.size >= 50)
          .map(([categoryId]) => categoryId),
      );
      expect(
        optimized.cells.map((cell) => ({
          cellId: cell.cellId,
          density: cell.density,
          categories: cell.categories,
        })),
      ).toEqual(
        [...referenceCells]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([cellId, cell]) => ({
            cellId,
            density: cell.density,
            categories: [...cell.categories]
              .filter((categoryId) => eligible.has(categoryId))
              .sort(),
          })),
      );
      const referenceAlphaPaths = new Map<string, number>();
      const alphaRows = validRows.filter((row) => row.category === "alpha");
      for (const row of alphaRows) {
        if (row.hierarchy !== null) {
          const path = row.hierarchy.trim().toLowerCase();
          referenceAlphaPaths.set(
            path,
            (referenceAlphaPaths.get(path) ?? 0) + 1,
          );
        }
      }
      expect(optimized.categories.get("alpha")?.hierarchy).toEqual(
        selectModalHierarchyPath(
          [...referenceAlphaPaths].map(([path, supportCount]) => ({
            path,
            supportCount,
          })),
          alphaRows.length,
        ),
      );
      expect(optimized.categories.get("beta")?.hierarchy.path).toBe(
        "root/beta",
      );
      expect(optimized.categories.has("gamma")).toBe(false);
    } finally {
      connection.closeSync();
    }
  });

  it("splits independently of category labels and deterministically", () => {
    const input = cells(96).map((cell, index) => ({
      ...cell,
      categories: index % 2 === 0 ? ["alpha"] : ["beta"],
    }));
    const relabeled = input.map((cell) => ({
      ...cell,
      categories: ["completely_different"],
    }));

    const first = splitDiscoveryCells(input, "release-seed");
    const second = splitDiscoveryCells(relabeled, "release-seed");

    expect(first.discovery.map((cell) => cell.cellId)).toEqual(
      second.discovery.map((cell) => cell.cellId),
    );
    expect(first.validation.map((cell) => cell.cellId)).toEqual(
      second.validation.map((cell) => cell.cellId),
    );
    expect(splitDiscoveryCells(input, "release-seed")).toEqual(first);
    expect(first.maximumWithinStratumImbalance).toBeLessThanOrEqual(1);
  });

  it("rejects a degenerate one-sided split", () => {
    expect(() => splitDiscoveryCells(cells(1), "seed")).toThrow(
      /split is degenerate/,
    );
  });

  it("computes analytic hypergeometric mean and variance", () => {
    expect(hypergeometricMoments(10, 4, 5)).toEqual({
      expectation: 2,
      variance: 2 / 3,
    });
  });

  it("normalizes exact hypergeometric probabilities and matches a brute-force tail", () => {
    const pmf = hypergeometricPmf(4, 2, 2);
    expect(pmf[0]).toBeCloseTo(1 / 6);
    expect(pmf[1]).toBeCloseTo(4 / 6);
    expect(pmf[2]).toBeCloseTo(1 / 6);
    expect(pmf.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);

    const input = cells(4).map((cell, index) => ({
      ...cell,
      categories: [
        ...(index < 2 ? ["a"] : []),
        ...(index === 0 || index === 2 ? ["b"] : []),
      ],
    }));
    const exact = exactStratifiedHypergeometricNull(input, "a", "b", 2);
    expect(exact.rawPValue).toBeCloseTo(1 / 6);
    expect(exact.conservativePValue).toBeCloseTo(1 / 6 + EXACT_NULL_EPSILON);
    expect(exact.meanExpectedJointCells).toBe(1);
    expect(exact.varianceJointCells).toBeCloseTo(1 / 3);
    expect(exact.normalizationError).toBeLessThan(1e-12);
  });

  it("matches brute-force convolution across independent strata", () => {
    const input: DiscoveryCell[] = [
      ...cells(4).map((cell, index) => ({
        ...cell,
        categories: [
          ...(index < 2 ? ["a"] : []),
          ...(index === 0 || index === 2 ? ["b"] : []),
        ],
      })),
      ...cells(4).map((cell, index) => ({
        ...cell,
        cellId: `8:${index}`,
        latitudeIndex: 8,
        longitudeIndex: index,
        categories: [
          ...(index < 2 ? ["a"] : []),
          ...(index === 0 || index === 2 ? ["b"] : []),
        ],
      })),
    ];
    const exact = exactStratifiedHypergeometricNull(input, "a", "b", 3);
    // Two independent [1,4,1]/6 distributions: P(total >= 3)=9/36.
    expect(exact.rawPValue).toBeCloseTo(1 / 4);
    expect(exact.meanExpectedJointCells).toBe(2);
    expect(exact.varianceJointCells).toBeCloseTo(2 / 3);
  });

  it("matches existing conditioned permutation moments within calibration error", () => {
    const input = cells(64).map((cell, index) => ({
      ...cell,
      categories: [
        ...(index < 32 ? ["a"] : []),
        ...(index % 2 === 0 ? ["b"] : []),
      ],
    }));
    const exact = exactStratifiedHypergeometricNull(input, "a", "b", 16);
    const permutation = runDensityConditionedNullModel(
      input.map((cell) => ({
        cellId: cell.cellId,
        latitudeIndex: cell.latitudeIndex,
        longitudeIndex: cell.longitudeIndex,
        density: cell.density,
        hasCategoryA: cell.categories.includes("a"),
        hasCategoryB: cell.categories.includes("b"),
      })),
      "calibration-seed",
      16,
    );

    expect(permutation.meanExpectedJointCells).toBeCloseTo(
      exact.meanExpectedJointCells,
      0,
    );
    expect(permutation.standardDeviationJointCells ** 2).toBeCloseTo(
      exact.varianceJointCells,
      0,
    );
  });

  it("applies Holm to every family member deterministically under ties", () => {
    expect(holmAdjust([0.01, 0.01, 0.04])).toEqual([0.03, 0.03, 0.04]);
    expect(holmAdjust([1, 0.01])).toEqual([1, 0.02]);
    expect(() => holmAdjust([Number.NaN])).toThrow(/finite/);
  });

  it("uses inclusive empirical CDF ties and nearest-rank boundaries", () => {
    const sorted = [0.1, 0.2, 0.2, 0.4, 0.5];
    expect(inclusiveEmpiricalPercentile(sorted, 0.2)).toEqual({
      numerator: 3,
      value: 0.6,
    });
    expect(inclusiveEmpiricalPercentile(sorted, 0.199)).toEqual({
      numerator: 1,
      value: 0.2,
    });
    expect(nearestRankQuantile(sorted, 0)).toBe(0.1);
    expect(nearestRankQuantile(sorted, 0.8)).toBe(0.4);
    expect(nearestRankQuantile(sorted, 1)).toBe(0.5);
  });

  it("requires the calibrated distance and percentile guards together", () => {
    expect(passesCalibratedSemanticGuard(0.35, 0.8)).toBe(true);
    expect(passesCalibratedSemanticGuard(0.349999, 1)).toBe(false);
    expect(passesCalibratedSemanticGuard(1, 0.799999)).toBe(false);
    for (const relatedControlDistance of [0.239, 0.075, 0.287, 0.341]) {
      expect(passesCalibratedSemanticGuard(relatedControlDistance, 1)).toBe(
        false,
      );
    }
  });

  it("fails exact convolution closed when a computation bound is exceeded", () => {
    const firstStratum = cells(4).map((cell, index) => ({
      ...cell,
      categories: [
        ...(index < 2 ? ["a"] : []),
        ...(index % 2 === 0 ? ["b"] : []),
      ],
    }));
    const input = [
      ...firstStratum,
      ...firstStratum.map((cell, index) => ({
        ...cell,
        cellId: `8:${index}`,
        latitudeIndex: 8,
        longitudeIndex: index,
      })),
    ];
    const result = exactStratifiedHypergeometricNull(input, "a", "b", 1, {
      maximumTransitions: 0,
    });

    expect(result.rawPValue).toBeNull();
    expect(result.conservativePValue).toBeNull();
    expect(result.meanExpectedJointCells).toBe(2);
    expect(result.varianceJointCells).toBeCloseTo(2 / 3);
    expect(result.reason).toMatch(/computation cap/);
  });

  it("fails closed rather than truncating eligible categories", async () => {
    const input = cells(50).map((cell) => ({
      ...cell,
      categories: Array.from(
        { length: MAX_ELIGIBLE_CATEGORIES + 1 },
        (_, index) => `category_${index}`,
      ),
    }));
    const evidence = new Map(
      input[0]!.categories.map((id) => [id, category(id)]),
    );

    await expect(
      discoverCandidateFamilyFromCells(input, evidence, "seed", runtime({})),
    ).rejects.toThrow(/no category was truncated/);
  });

  it("returns an explicit empty family when discovery guards find nothing", async () => {
    const input = cells(120).map((cell, index) => ({
      ...cell,
      categories: [
        ...(index < 50 ? ["alpha"] : []),
        ...(index >= 50 && index < 100 ? ["beta"] : []),
      ],
    }));
    const result = await discoverCandidateFamilyFromCells(
      input,
      new Map([
        ["alpha", category("alpha")],
        ["beta", category("beta")],
      ]),
      "seed",
      runtime({}),
    );

    expect(result.census.declaredPairFrontier).toBe(1);
    expect(result.semanticFrontier).toEqual([]);
    expect(result.validationFamily).toEqual([]);
    expect(result.emptyReason).toMatch(/No discovery-half pair/);
  });

  it("fails semantic selection closed while preserving the ranked frontier", async () => {
    const input = cells(200).map((cell, index) => ({
      ...cell,
      categories: index < 64 ? ["alpha", "beta"] : [],
    }));
    const failedRuntime: PlaceColocationEmbeddingRuntime = {
      ...runtime({}),
      embedMany: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    };
    const result = await discoverCandidateFamilyFromCells(
      input,
      new Map([
        ["alpha", category("alpha")],
        ["beta", category("beta")],
      ]),
      "seed",
      failedRuntime,
    );

    expect(result.semanticFrontier).toEqual([]);
    expect(result.semanticAudit.corpus.digest).toBeNull();
    expect(result.semanticAudit.referenceDistribution.digest).toBeNull();
    expect(result.semanticAudit.spatialLedger.digest).toBeNull();
    expect(result.census.semanticEvaluatedPairs).toBe(0);
    expect(result.validationFamily).toEqual([]);
    expect(result.emptyReason).toContain("provider unavailable");
  });

  it("keeps an unrelated synthetic pair and rejects a related high-lift control", async () => {
    const input = cells(400).map((cell, index) => ({
      ...cell,
      categories: [
        ...(index < 100 ? ["related_a", "related_b"] : []),
        ...(index >= 128 && index < 192 ? ["unrelated_x", "unrelated_y"] : []),
        ...(index >= 250 && index < 310 ? ["isolated"] : []),
      ],
    }));
    const evidence = new Map(
      ["related_a", "related_b", "unrelated_x", "unrelated_y", "isolated"].map(
        (id) => [id, category(id)],
      ),
    );
    const semanticRuntime = runtime({
      related_a: [1, 0],
      related_b: [0.99, 0.01],
      unrelated_x: [1, 0],
      unrelated_y: [0, 1],
      isolated: [Math.SQRT1_2, Math.SQRT1_2],
    });
    const result = await discoverCandidateFamilyFromCells(
      input,
      evidence,
      "fixture-release-seed",
      semanticRuntime,
    );
    const reordered = await discoverCandidateFamilyFromCells(
      input.map((cell) => ({
        ...cell,
        categories: [...cell.categories].reverse(),
      })),
      new Map([...evidence.entries()].reverse()),
      "fixture-release-seed",
      runtime({
        related_a: [1, 0],
        related_b: [0.99, 0.01],
        unrelated_x: [1, 0],
        unrelated_y: [0, 1],
        isolated: [Math.SQRT1_2, Math.SQRT1_2],
      }),
    );

    expect(result.census.declaredPairFrontier).toBe(10);
    expect(reordered).toEqual(result);
    expect(result.census.discoveryGuardPassingPairs).toBe(2);
    expect(result.census.semanticUniqueCategories).toBe(5);
    expect(result.census.semanticReferencePairs).toBe(10);
    expect(result.census.semanticEvaluatedPairs).toBe(2);
    expect(result.census.semanticPassingPairs).toBe(1);
    expect(result.semanticFrontier).toHaveLength(1);
    expect(result.semanticFrontier[0]).toMatchObject({
      rank: 1,
      discoveryRank: 2,
      categoryA: { id: "unrelated_x" },
      categoryB: { id: "unrelated_y" },
      semantic: { value: 1, passed: true },
    });
    expect(semanticRuntime.embedMany).toHaveBeenCalledTimes(1);
    const embeddedGlosses = vi.mocked(semanticRuntime.embedMany).mock
      .calls[0]?.[0];
    expect(embeddedGlosses).toHaveLength(5);
    expect(new Set(embeddedGlosses).size).toBe(5);
    expect(result.semanticAudit).toMatchObject({
      corpus: { eligibleCategories: 5 },
      referenceDistribution: { pairCount: 10 },
      spatialLedger: { entries: 2 },
    });
    expect(result.semanticAudit.corpus.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.semanticAudit.referenceDistribution.digest).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(result.semanticAudit.spatialLedger.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.validationFamily).toHaveLength(1);
    expect(result.validationFamily[0]).toMatchObject({
      categoryA: { id: "unrelated_x" },
      categoryB: { id: "unrelated_y" },
      semantic: { value: 1 },
      validation: {
        guards: { jointPassed: true, rawLiftPassed: true },
      },
      fullUniverse: {
        magnitudeFloor: 50,
        guards: { jointPassed: true, rawLiftPassed: true },
      },
    });
    expect(
      result.validationFamily[0]!.validation.null.rawPValue,
    ).not.toBeNull();
    expect(result.validationFamily[0]!.validation.null.holmFamilySize).toBe(1);
  });

  it("fails closed when an embedding batch is partial", async () => {
    const input = cells(200).map((cell, index) => ({
      ...cell,
      categories: index < 64 ? ["alpha", "beta"] : [],
    }));
    const partialRuntime: PlaceColocationEmbeddingRuntime = {
      ...runtime({}),
      embedMany: vi.fn(async (glosses) =>
        glosses.slice(0, 1).map((text) => ({
          text,
          embedding: [1, 0],
        })),
      ),
    };
    const result = await discoverCandidateFamilyFromCells(
      input,
      new Map([
        ["alpha", category("alpha")],
        ["beta", category("beta")],
      ]),
      "seed",
      partialRuntime,
    );

    expect(result.census.semanticUniqueCategories).toBe(2);
    expect(result.census.semanticEvaluatedPairs).toBe(0);
    expect(result.semanticAudit.corpus.digest).toBeNull();
    expect(result.semanticAudit.referenceDistribution.digest).toBeNull();
    expect(result.semanticAudit.spatialLedger.digest).toBeNull();
    expect(result.semanticFrontier).toEqual([]);
    expect(result.validationFamily).toEqual([]);
    expect(result.emptyReason).toMatch(/canonical gloss order/);
  });

  it("keeps the full semantic reference independent of spatial outcomes", async () => {
    const ids = ["alpha", "beta", "gamma", "delta"];
    const makeInput = (pairs: readonly (readonly [string, string])[]) =>
      cells(400).map((cell, index) => ({
        ...cell,
        categories:
          index < 100
            ? [...pairs[0]!]
            : index >= 128 && index < 228
              ? [...pairs[1]!]
              : [],
      }));
    const vectors = {
      alpha: [1, 0],
      beta: [0.9, 0.1],
      gamma: [0, 1],
      delta: [0.1, 0.9],
    };
    const evidence = new Map(ids.map((id) => [id, category(id)]));
    const first = await discoverCandidateFamilyFromCells(
      makeInput([
        ["alpha", "beta"],
        ["gamma", "delta"],
      ]),
      evidence,
      "same-release",
      runtime(vectors),
    );
    const second = await discoverCandidateFamilyFromCells(
      makeInput([
        ["alpha", "gamma"],
        ["beta", "delta"],
      ]),
      evidence,
      "same-release",
      runtime(vectors),
    );

    expect(second.semanticAudit.corpus).toEqual(first.semanticAudit.corpus);
    expect(second.semanticAudit.referenceDistribution).toEqual(
      first.semanticAudit.referenceDistribution,
    );
    expect(second.semanticAudit.spatialLedger.digest).not.toBe(
      first.semanticAudit.spatialLedger.digest,
    );
  });

  it("hashes the complete semantic ledger canonically and sensitively", () => {
    const base = [
      {
        categoryA: "alpha",
        categoryB: "beta",
        provider: "openai" as const,
        model: "model-a",
        vectorHashA: "hash-a",
        vectorHashB: "hash-b",
        distance: 0.75,
        inclusiveCdfNumerator: 2,
        referencePairCount: 2,
      },
      {
        categoryA: "gamma",
        categoryB: "delta",
        provider: "openai" as const,
        model: "model-a",
        vectorHashA: "hash-g",
        vectorHashB: "hash-d",
        distance: 0.5,
        inclusiveCdfNumerator: 1,
        referencePairCount: 2,
      },
    ];
    const digest = computeSemanticLedgerDigest(base);
    expect(computeSemanticLedgerDigest([...base].reverse())).toBe(digest);
    expect(
      computeSemanticLedgerDigest([
        {
          ...base[0]!,
          categoryA: "beta",
          categoryB: "alpha",
          vectorHashA: "hash-b",
          vectorHashB: "hash-a",
        },
        base[1]!,
      ]),
    ).toBe(digest);
    for (const changed of [
      [{ ...base[0]!, model: "model-b" }, base[1]!],
      [{ ...base[0]!, vectorHashA: "changed" }, base[1]!],
      [{ ...base[0]!, distance: 0.7500000000000001 }, base[1]!],
      [{ ...base[0]!, inclusiveCdfNumerator: 1 }, base[1]!],
      [{ ...base[0]!, categoryB: "changed" }, base[1]!],
    ]) {
      expect(computeSemanticLedgerDigest(changed)).not.toBe(digest);
    }
  });

  it("hashes the eligible gloss/vector corpus canonically", () => {
    const corpus = [
      { id: "beta", gloss: "beta gloss", vectorHash: "hash-b" },
      { id: "alpha", gloss: "alpha gloss", vectorHash: "hash-a" },
    ];
    const digest = computeSemanticCorpusDigest(corpus, "openai", "test-model");
    expect(
      computeSemanticCorpusDigest(
        [...corpus].reverse(),
        "openai",
        "test-model",
      ),
    ).toBe(digest);
    expect(
      computeSemanticCorpusDigest(
        [{ ...corpus[0]!, gloss: "changed" }, corpus[1]!],
        "openai",
        "test-model",
      ),
    ).not.toBe(digest);
    expect(
      computeSemanticCorpusDigest(corpus, "openai", "different-model"),
    ).not.toBe(digest);
  });

  it("keeps the response bounded after evaluating a larger semantic ledger", async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `category_${index}`);
    const input = cells(400).map((cell, index) => ({
      ...cell,
      categories: index < 64 ? ids : [],
    }));
    const vectors = Object.fromEntries(
      ids.map((id, index) => [
        id,
        Array.from({ length: ids.length }, (_, vectorIndex) =>
          vectorIndex === index ? 1 : 0,
        ),
      ]),
    );
    const result = await discoverCandidateFamilyFromCells(
      input,
      new Map(ids.map((id) => [id, category(id)])),
      "bounded-ledger-seed",
      runtime(vectors),
    );

    expect(result.census.discoveryGuardPassingPairs).toBe(66);
    expect(result.census.semanticEvaluatedPairs).toBe(66);
    expect(result.census.semanticPassingPairs).toBe(66);
    expect(result.semanticAudit.referenceDistribution.pairCount).toBe(66);
    expect(result.semanticAudit.spatialLedger.entries).toBe(66);
    expect(result.semanticFrontier).toHaveLength(32);
    expect(result.validationFamily).toHaveLength(5);
  });

  it.skipIf(process.env.RUN_COLOCATION_BENCHMARK !== "1")(
    "benchmarks the maximum declared pair frontier",
    async () => {
      const input = cells(20_000).map((cell, index) => ({
        ...cell,
        categories:
          index < 50
            ? Array.from(
                { length: MAX_ELIGIBLE_CATEGORIES },
                (_, categoryIndex) => `category_${categoryIndex}`,
              )
            : [],
      }));
      const evidence = new Map(
        input[0]!.categories.map((id) => [id, category(id)]),
      );
      const startedAt = performance.now();
      const result = await discoverCandidateFamilyFromCells(
        input,
        evidence,
        "max-frontier-seed",
        runtime({}),
      );
      const elapsedMilliseconds = Math.round(performance.now() - startedAt);
      const exactInput = input.map((cell, index) => ({
        ...cell,
        categories: [
          ...(index % 64 < 32 ? ["exact_a"] : []),
          ...(index % 2 === 0 ? ["exact_b"] : []),
        ],
      }));
      const exactStartedAt = performance.now();
      const exact = exactStratifiedHypergeometricNull(
        exactInput,
        "exact_a",
        "exact_b",
        10_000,
      );
      const exactElapsedMilliseconds = Math.round(
        performance.now() - exactStartedAt,
      );
      console.info(
        JSON.stringify({
          benchmark: "maximum-declared-discovery-frontier",
          occupiedCells: input.length,
          pairs: result.census.declaredPairFrontier,
          elapsedMilliseconds,
          exactElapsedMilliseconds,
          exactStates: exact.stateCount,
          exactTransitions: exact.transitionCount,
          exactFailedClosed: exact.reason !== null,
        }),
      );
      expect(result.census.declaredPairFrontier).toBe(32_640);
      expect(elapsedMilliseconds).toBeLessThan(10_000);
      expect(exactElapsedMilliseconds).toBeLessThan(10_000);
    },
    15_000,
  );
});
