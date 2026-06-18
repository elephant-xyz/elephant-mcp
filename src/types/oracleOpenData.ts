import { z } from "zod";

export const OracleManifestEntrySchema = z.object({
  parcelId: z.string(),
  filePath: z.string(),
  fileSizeBytes: z.number(),
  sha256: z.string(),
  cid: z.string(),
  collectedAt: z.string(),
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
  parcelId: string;
  cid: string;
  county: string;
  collectedAt: string;
  fileSizeBytes: number;
}

export interface ListOraclePropertiesResult {
  total: number;
  offset: number;
  limit: number;
  properties: SlimPropertyEntry[];
}
