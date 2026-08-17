import { z } from "zod";

export const OracleManifestEntrySchema = z.object({
  propertyId: z.string(),
  parcelIdentifier: z.string(),
  filePath: z.string(),
  fileSizeBytes: z.number(),
  sha256: z.string(),
  cid: z.string(),
});

export type OracleManifestEntry = z.infer<typeof OracleManifestEntrySchema>;

export const OracleManifestSchema = z.object({
  schemaVersion: z.string().optional(),
  county: z.string(),
  exportedAt: z.string().optional(),
  completedAt: z.string().optional(),
  propertyCount: z.number(),
  totalBytes: z.number().optional(),
  entries: z.array(OracleManifestEntrySchema),
});

export type OracleManifest = z.infer<typeof OracleManifestSchema>;

export interface SlimPropertyEntry {
  propertyId: string;
  parcelIdentifier: string;
  cid: string | null;
  county: string;
  /**
   * Per-property file size from the legacy manifest/sharded index. The
   * query-table path does not carry this, so it is null there.
   */
  fileSizeBytes: number | null;
  /** Situs street address (query-table path only; omitted on the legacy path). */
  address?: string | null;
  /** Market/just value from the appraiser roll (query-table path only). */
  marketValue?: number | null;
  /** Primary owner name (query-table path only). */
  ownerName?: string | null;
}

export interface ListOraclePropertiesResult {
  total: number;
  offset: number;
  limit: number;
  properties: SlimPropertyEntry[];
}

// A single entry inside a shard file (compact — no filePath or sha256)
export const ShardEntrySchema = z.object({
  propertyId: z.string(),
  parcelIdentifier: z.string(),
  cid: z.string().nullable(),
  fileSizeBytes: z.number(),
});
export type ShardEntry = z.infer<typeof ShardEntrySchema>;

// A shard file (shards/shard-NNNN.json)
export const ShardFileSchema = z.object({
  schemaVersion: z.literal("1"),
  shardIndex: z.number().int().nonnegative(),
  fromParcel: z.string(),
  toParcel: z.string(),
  count: z.number().int().positive(),
  entries: z.array(ShardEntrySchema),
});
export type ShardFile = z.infer<typeof ShardFileSchema>;

// A reference to one shard, stored in index.json's shards array
export const ShardRefSchema = z.object({
  shardIndex: z.number().int().nonnegative(),
  fromParcel: z.string(),
  toParcel: z.string(),
  count: z.number().int().nonnegative(),
  shardCid: z.string().nullable(),
});
export type ShardRef = z.infer<typeof ShardRefSchema>;

// The top-level index file (index.json)
export const OracleIndexSchema = z.object({
  schemaVersion: z.literal("1"),
  county: z.string(),
  exportedAt: z.string(),
  completedAt: z.string(),
  propertyCount: z.number().int().nonnegative(),
  shardSize: z.number().int().positive(),
  totalBytes: z.number().nonnegative(),
  shards: z.array(ShardRefSchema),
});
export type OracleIndex = z.infer<typeof OracleIndexSchema>;

// ---------------------------------------------------------------------------
// Per-source dataset coverage
//
// Mirrors the `oracle_dataset_coverage` snapshot written by the query-db
// publish loop to `incremental-status/<county>/dataset-coverage.json`. The MCP
// reads this JSON (over HTTP or a local path) so `getOracleDatasetInfo` can
// report count/%/date-range per source (appraisal, permits, corporate, bbb),
// without a Postgres dependency. Extra keys are ignored so the contract can
// grow on the producer side without breaking reads.
// ---------------------------------------------------------------------------

const CoverageCountSchema = z.number().int().nonnegative();
const CoveragePercentSchema = z.number().int().min(0).max(100);
const NullableStringSchema = z.string().nullable().optional();

/**
 * Select the producer-format value when present, otherwise use its legacy
 * camelCase alias. Null is a meaningful value and therefore does not fall
 * through to the alias.
 *
 * @template Value - Type shared by the aliased fields.
 * @param preferred - Value from the current snake_case producer contract.
 * @param legacy - Value from the legacy camelCase contract.
 * @returns The selected value, or undefined when neither alias is present.
 */
function selectCoverageAlias<Value>(
  preferred: Value | undefined,
  legacy: Value | undefined,
): Value | undefined {
  return preferred !== undefined ? preferred : legacy;
}

/**
 * Report conflicting aliases instead of silently accepting whichever spelling
 * happens to be checked first.
 *
 * @template Value - Type shared by the aliased fields.
 * @param preferred - Value from the current snake_case producer contract.
 * @param legacy - Value from the legacy camelCase contract.
 * @returns True when at most one alias is present or both values are identical.
 */
function coverageAliasesAgree<Value>(
  preferred: Value | undefined,
  legacy: Value | undefined,
): boolean {
  return (
    preferred === undefined ||
    legacy === undefined ||
    Object.is(preferred, legacy)
  );
}

/**
 * Derive the whole-number completion value used by the MCP response.
 *
 * @param ingestedCount - Number of records loaded from the source.
 * @param expectedCount - Expected source count, or null/undefined if unknown.
 * @returns Rounded completion percent, or null when no positive target exists.
 */
function deriveCoverageCompletion(
  ingestedCount: number,
  expectedCount: number | null | undefined,
): number | null {
  if (
    expectedCount === null ||
    expectedCount === undefined ||
    expectedCount <= 0
  ) {
    return null;
  }
  return Math.round((ingestedCount / expectedCount) * 100);
}

/**
 * One row of a published coverage snapshot.
 *
 * The query-db publisher emits snake_case fields. CamelCase aliases remain
 * accepted for snapshots produced against the older MCP-facing contract. The
 * schema normalizes every accepted row to snake_case and validates optional
 * producer-supplied completion values against the source counts.
 */
export const OracleDatasetCoverageRowSchema = z
  .object({
    county: z.string(),
    source: z.string(),
    ingested_count: CoverageCountSchema.optional(),
    ingestedCount: CoverageCountSchema.optional(),
    expected_count: CoverageCountSchema.nullable().optional(),
    expectedCount: CoverageCountSchema.nullable().optional(),
    first_loaded_at: NullableStringSchema,
    firstLoadedAt: NullableStringSchema,
    last_loaded_at: NullableStringSchema,
    lastLoadedAt: NullableStringSchema,
    cid: NullableStringSchema,
    ipns_label: NullableStringSchema,
    ipnsLabel: NullableStringSchema,
    scope_note: NullableStringSchema,
    scopeNote: NullableStringSchema,
    completion_percent: CoveragePercentSchema.nullable().optional(),
    completionPercent: CoveragePercentSchema.nullable().optional(),
  })
  .passthrough()
  .superRefine((row, context) => {
    const aliases = [
      ["ingested_count", row.ingested_count, row.ingestedCount],
      ["expected_count", row.expected_count, row.expectedCount],
      ["first_loaded_at", row.first_loaded_at, row.firstLoadedAt],
      ["last_loaded_at", row.last_loaded_at, row.lastLoadedAt],
      ["ipns_label", row.ipns_label, row.ipnsLabel],
      ["scope_note", row.scope_note, row.scopeNote],
      ["completion_percent", row.completion_percent, row.completionPercent],
    ] as const;

    for (const [field, preferred, legacy] of aliases) {
      if (!coverageAliasesAgree(preferred, legacy)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `Conflicting snake_case and camelCase values for ${field}`,
        });
      }
    }

    const ingestedCount = selectCoverageAlias(
      row.ingested_count,
      row.ingestedCount,
    );
    if (ingestedCount === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ingested_count"],
        message: "Coverage row requires ingested_count or ingestedCount",
      });
      return;
    }

    const expectedCount = selectCoverageAlias(
      row.expected_count,
      row.expectedCount,
    );
    const suppliedCompletion = selectCoverageAlias(
      row.completion_percent,
      row.completionPercent,
    );
    if (
      suppliedCompletion !== undefined &&
      suppliedCompletion !==
        deriveCoverageCompletion(ingestedCount, expectedCount)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completion_percent"],
        message: "Coverage completion does not match ingested/expected counts",
      });
    }
  })
  .transform((row) => {
    const ingestedCount = selectCoverageAlias(
      row.ingested_count,
      row.ingestedCount,
    );
    if (ingestedCount === undefined) {
      throw new Error("Validated coverage row is missing its ingested count");
    }

    return {
      ...row,
      ingested_count: ingestedCount,
      expected_count: selectCoverageAlias(
        row.expected_count,
        row.expectedCount,
      ),
      first_loaded_at: selectCoverageAlias(
        row.first_loaded_at,
        row.firstLoadedAt,
      ),
      last_loaded_at: selectCoverageAlias(row.last_loaded_at, row.lastLoadedAt),
      ipns_label: selectCoverageAlias(row.ipns_label, row.ipnsLabel),
      scope_note: selectCoverageAlias(row.scope_note, row.scopeNote),
    };
  });
export type OracleDatasetCoverageRow = z.infer<
  typeof OracleDatasetCoverageRowSchema
>;

/**
 * The published snapshot. The current producer uses `exportedAt`; the
 * `exported_at` alias is accepted and normalized for compatibility.
 */
export const OracleDatasetCoverageSnapshotSchema = z
  .object({
    county: z.string(),
    exportedAt: z.string().optional(),
    exported_at: z.string().optional(),
    datasets: z.array(OracleDatasetCoverageRowSchema),
  })
  .passthrough()
  .superRefine((snapshot, context) => {
    if (!coverageAliasesAgree(snapshot.exportedAt, snapshot.exported_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exportedAt"],
        message: "Conflicting exportedAt and exported_at values",
      });
    }
  })
  .transform((snapshot) => ({
    ...snapshot,
    exportedAt: selectCoverageAlias(snapshot.exportedAt, snapshot.exported_at),
  }));
export type OracleDatasetCoverageSnapshot = z.infer<
  typeof OracleDatasetCoverageSnapshotSchema
>;

/**
 * Per-source coverage as reported in `getOracleDatasetInfo.datasets[]`
 * (camelCase, with a derived completion percent).
 */
export interface OracleDatasetInfoCoverageEntry {
  source: string;
  ingestedCount: number;
  expectedCount: number | null;
  /** round(ingested/expected * 100) when expected > 0, else null. */
  completionPercent: number | null;
  firstLoadedAt: string | null;
  lastLoadedAt: string | null;
  cid: string | null;
  ipnsLabel: string | null;
  /** Source-specific coverage qualification when required for safe interpretation. */
  scopeNote?: string;
}
