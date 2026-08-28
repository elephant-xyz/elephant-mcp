import { z } from "zod";

export const PublicationScopeSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    level: z.enum(["full", "partial", "pilot"]),
    denominatorBasis: z.enum(["county_total", "published_subset"]),
  })
  .strict()
  .superRefine((scope, context) => {
    if (
      (scope.level === "full" && scope.denominatorBasis !== "county_total") ||
      (scope.level === "pilot" && scope.denominatorBasis !== "published_subset")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          scope.level === "full"
            ? "full coverage requires a county_total denominator"
            : "pilot coverage requires a published_subset denominator",
      });
    }
  });

export const PublishedCountySchema = z
  .object({
    countyKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    countyName: z.string().min(1),
    stateCode: z.string().regex(/^[A-Z]{2}$/),
    countyFips: z.string().regex(/^\d{5}$/),
    status: z.literal("published"),
    publicationScope: PublicationScopeSchema.optional(),
    queryTableUrl: z.string().url(),
    datasetCoverageUrl: z.string().url(),
    permitQueryTableUrl: z.string().url().nullable(),
    placesTableUrl: z.string().url().nullable(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const PublishedCountyCatalogSchema = z
  .object({
    schemaVersion: z.enum(["1.0", "1.1"]),
    generatedAt: z.string().datetime({ offset: true }),
    counties: z.array(PublishedCountySchema),
  })
  .strict()
  .superRefine((catalog, context) => {
    if (catalog.schemaVersion !== "1.1") return;
    catalog.counties.forEach((county, index) => {
      if (county.publicationScope === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["counties", index, "publicationScope"],
          message: "catalog schema 1.1 requires explicit publicationScope",
        });
      }
    });
  });

export type PublicationScope = z.infer<typeof PublicationScopeSchema>;
export type PublishedCounty = z.infer<typeof PublishedCountySchema>;
export type PublishedCountyCatalog = z.infer<
  typeof PublishedCountyCatalogSchema
>;
