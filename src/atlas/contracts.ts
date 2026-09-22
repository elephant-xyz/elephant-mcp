import { CID } from "multiformats/cid";
import { z } from "zod";

const COUNTY_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Data-group, table, and column names: snake_case starting with a letter. */
export const ATLAS_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

const CountyIdentifierSchema = z
  .string()
  .regex(COUNTY_IDENTIFIER_PATTERN, "invalid county identifier");

export const AtlasIdentifierSchema = z
  .string()
  .regex(ATLAS_IDENTIFIER_PATTERN, "invalid identifier");

const canonicalCidV1StringSchema = z.string().refine(
  (value) => {
    try {
      const cid = CID.parse(value);
      return cid.version === 1 && cid.toString() === value;
    } catch {
      return false;
    }
  },
  {
    message: "expected a canonical lowercase base32 CIDv1",
  },
);

/**
 * A CIDv1 represented as canonical lowercase base32.
 *
 * DAG-JSON decoders return CID objects, while the Atlas index contains CID
 * strings. Both inputs are accepted and normalized to the same string form.
 */
export const CidV1Schema = z.preprocess((value) => {
  const cid = CID.asCID(value);
  return cid?.toString() ?? value;
}, canonicalCidV1StringSchema);

const safeCountSchema = z.number().int().nonnegative().safe();
const safeByteCountSchema = z.number().int().positive().safe();

export const AtlasGroupV1Schema = z
  .object({
    cid: CidV1Schema,
    schema: CidV1Schema,
    tables: CidV1Schema,
    published_at: z.string().datetime({ offset: true }),
  })
  .strict();

const atlasGroupsV1Schema = z
  .record(AtlasIdentifierSchema, AtlasGroupV1Schema)
  .refine((groups) => Object.keys(groups).length > 0, {
    message: "an indexed county must contain at least one data group",
  });

export const AtlasCountyV1Schema = z
  .object({
    county: CountyIdentifierSchema,
    state: z.string().regex(/^[A-Z]{2}$/u, "expected a two-letter state code"),
    fips: z.string().regex(/^[0-9]{5}$/u, "expected a five-digit FIPS code"),
    groups: atlasGroupsV1Schema,
  })
  .strict();

export const AtlasIndexV1Schema = z
  .object({
    version: z.literal(1),
    generated_from: z
      .string()
      .regex(/^[0-9a-f]{40}$/u, "expected a lowercase 40-character git SHA"),
    counties: z.array(AtlasCountyV1Schema),
  })
  .strict()
  .superRefine((index, context) => {
    const counties = new Map<string, number>();
    const fipsCodes = new Map<string, number>();
    const archiveCids = new Map<string, string>();
    const tablesCids = new Map<string, string>();

    index.counties.forEach((county, position) => {
      const key = `${county.state}/${county.county}`;
      const existingCounty = counties.get(key);
      if (existingCounty !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["counties", position, "county"],
          message: `duplicate county ${key}; first declared at counties.${existingCounty}`,
        });
      } else {
        counties.set(key, position);
      }

      const existingFips = fipsCodes.get(county.fips);
      if (existingFips !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["counties", position, "fips"],
          message: `duplicate FIPS ${county.fips}; first declared at counties.${existingFips}`,
        });
      } else {
        fipsCodes.set(county.fips, position);
      }

      for (const [groupName, group] of Object.entries(county.groups)) {
        const groupPath = `${county.state}/${county.county}/${groupName}`;
        const archiveOwner = archiveCids.get(group.cid);
        if (archiveOwner !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["counties", position, "groups", groupName, "cid"],
            message: `archive CID is also registered by ${archiveOwner}`,
          });
        } else {
          archiveCids.set(group.cid, groupPath);
        }
        const tablesOwner = tablesCids.get(group.tables);
        if (tablesOwner !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["counties", position, "groups", groupName, "tables"],
            message: `tables CID is also registered by ${tablesOwner}`,
          });
        } else {
          tablesCids.set(group.tables, groupPath);
        }
      }
    });
  });

export const CountyIndexV1Schema = z
  .object({
    label: z.literal("CountyIndex"),
    version: z.literal(1),
    properties: safeCountSchema,
    shards: z.array(CidV1Schema),
  })
  .strict();

export const CountyTablePartV1Schema = z
  .object({
    cid: CidV1Schema,
    rows: safeCountSchema,
    bytes: safeByteCountSchema,
  })
  .strict();

export const CountyTableV1Schema = z
  .object({
    rows: safeCountSchema,
    parts: z.array(CountyTablePartV1Schema),
  })
  .strict();

const countyTablesRecordV1Schema = z
  .record(AtlasIdentifierSchema, CountyTableV1Schema)
  .refine((tables) => Object.keys(tables).length > 0, {
    message: "CountyTables must contain at least one table",
  });

export const CountyTablesV1Schema = z
  .object({
    label: z.literal("CountyTables"),
    version: z.literal(1),
    county_root: CidV1Schema,
    part_size_bytes: safeByteCountSchema,
    codec: z.literal("zstd"),
    tables: countyTablesRecordV1Schema,
  })
  .strict()
  .superRefine((countyTables, context) => {
    const partCids = new Map<string, { table: string; position: number }>();

    for (const [tableName, table] of Object.entries(countyTables.tables)) {
      let rows = 0;

      table.parts.forEach((part, position) => {
        if (part.bytes > countyTables.part_size_bytes) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tables", tableName, "parts", position, "bytes"],
            message: `part exceeds the ${countyTables.part_size_bytes}-byte limit`,
          });
        }
        const nextRows = rows + part.rows;
        if (!Number.isSafeInteger(nextRows)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tables", tableName, "parts", position, "rows"],
            message: "part row total exceeds the safe integer range",
          });
        } else {
          rows = nextRows;
        }

        const existing = partCids.get(part.cid);
        if (existing !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tables", tableName, "parts", position, "cid"],
            message:
              `duplicate part CID ${part.cid}; first declared at ` +
              `tables.${existing.table}.parts.${existing.position}`,
          });
        } else {
          partCids.set(part.cid, { table: tableName, position });
        }
      });

      if (rows !== table.rows) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tables", tableName, "rows"],
          message: `table declares ${table.rows} rows but its parts declare ${rows}`,
        });
      }
    }
  });

/**
 * Validate a CountyTables block and bind it to its Atlas archive root.
 */
export function parseCountyTablesV1(
  value: unknown,
  expectedCountyRoot: string,
): CountyTablesV1 {
  const expected = CidV1Schema.parse(expectedCountyRoot);
  return CountyTablesV1Schema.superRefine((countyTables, context) => {
    if (countyTables.county_root !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["county_root"],
        message: `county_root is ${countyTables.county_root}, expected ${expected}`,
      });
    }
  }).parse(value);
}

export type AtlasIndexV1 = z.infer<typeof AtlasIndexV1Schema>;
export type CountyIndexV1 = z.infer<typeof CountyIndexV1Schema>;
export type CountyTablesV1 = z.infer<typeof CountyTablesV1Schema>;
