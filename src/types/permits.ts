import { z } from "zod";

export const PermitRecordSchema = z.object({
  permitNumber: z.string(),
  permitType: z.string().optional(),
  status: z.string().optional(),
  issuedDate: z.string().optional(),
  expiresDate: z.string().optional(),
  description: z.string().optional(),
  contractor: z.string().optional(),
  valuation: z.number().optional(),
  address: z.string().optional(),
});

export type PermitRecord = z.infer<typeof PermitRecordSchema>;

export const PermitCacheEntrySchema = z.object({
  parcelId: z.string(),
  countyFips: z.string(),
  harvestedAt: z.string(),
  permits: z.array(PermitRecordSchema),
  cid: z.string().optional(),
});

export type PermitCacheEntry = z.infer<typeof PermitCacheEntrySchema>;

export const PermitHarvestStatusSchema = z.enum([
  "cached",
  "enqueued",
  "error",
]);

export type PermitHarvestStatus = z.infer<typeof PermitHarvestStatusSchema>;

export interface GetPropertyPermitsResult {
  status: PermitHarvestStatus;
  parcelId: string;
  countyFips: string;
  permits?: PermitRecord[];
  harvestedAt?: string;
  cid?: string;
  message?: string;
  estimatedWaitSeconds?: number;
}
