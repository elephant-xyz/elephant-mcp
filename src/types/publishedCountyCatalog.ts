import { z } from "zod";

export const PublishedCountySchema = z.object({
  countyKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  countyName: z.string().min(1),
  stateCode: z.string().regex(/^[A-Z]{2}$/),
  countyFips: z.string().regex(/^\d{5}$/),
  status: z.literal("published"),
  queryTableUrl: z.string().url(),
  datasetCoverageUrl: z.string().url(),
  permitQueryTableUrl: z.string().url().nullable(),
  placesTableUrl: z.string().url().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});

export const PublishedCountyCatalogSchema = z.object({
  schemaVersion: z.literal("1.0"),
  generatedAt: z.string().datetime({ offset: true }),
  counties: z.array(PublishedCountySchema),
});

export type PublishedCounty = z.infer<typeof PublishedCountySchema>;
export type PublishedCountyCatalog = z.infer<
  typeof PublishedCountyCatalogSchema
>;
