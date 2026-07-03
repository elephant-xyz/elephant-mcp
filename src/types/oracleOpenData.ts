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
