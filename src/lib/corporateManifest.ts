import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

/** The only currently approved public corporate-registration county. */
export const CORPORATE_ALLOWED_COUNTY_KEYS = ["rock-island"] as const;

/** The stable public schema version produced by elephant-query-db. */
export const CORPORATE_SCHEMA_VERSION =
  "illinois-sos-rock-island-corporate-registration-public-v1" as const;

/** The stable dataset name in the public corporate manifest. */
export const CORPORATE_DATASET_NAME =
  "rock_island_corporate_registrations" as const;

/** The exact Parquet artifact key selected from the public manifest. */
export const CORPORATE_PARQUET_ARTIFACT_KEY =
  "corporate-registrations/rock-island/corporate-registrations.parquet" as const;

/** The exact public-schema artifact key required by the manifest contract. */
export const CORPORATE_SCHEMA_ARTIFACT_KEY =
  "corporate-registrations/rock-island/corporate-registration-schema.json" as const;

/**
 * User-facing meaning attached to every corporate tool and coverage result.
 * Keep this explicit: the registry's county code is not property evidence.
 */
export const CORPORATE_SCOPE_NOTE =
  "County scope means registered-agent office county. It is not a business operating location and does not establish tenancy, occupancy, ownership, or any property association or linkage.";

/** Exact public organization-registry columns approved for MCP exposure. */
export const CORPORATE_PUBLIC_COLUMNS = [
  "illinois_file_number",
  "legal_company_name",
  "entity_type_code",
  "entity_type",
  "entity_status_code",
  "entity_status",
  "incorporation_date",
  "organization_date",
  "dissolution_date",
  "source_system",
  "master_snapshot_date",
  "name_snapshot_date",
  "agent_snapshot_date",
  "snapshot_consistency",
  "statewide_intersection_coverage_percent",
  "county_scope_type",
  "county_code",
  "county_label",
] as const;

/** DuckDB types expected from the approved public Parquet. */
export const CORPORATE_PUBLIC_DUCKDB_SCHEMA: Readonly<
  Record<(typeof CORPORATE_PUBLIC_COLUMNS)[number], string>
> = {
  illinois_file_number: "VARCHAR",
  legal_company_name: "VARCHAR",
  entity_type_code: "VARCHAR",
  entity_type: "VARCHAR",
  entity_status_code: "VARCHAR",
  entity_status: "VARCHAR",
  incorporation_date: "VARCHAR",
  organization_date: "VARCHAR",
  dissolution_date: "VARCHAR",
  source_system: "VARCHAR",
  master_snapshot_date: "VARCHAR",
  name_snapshot_date: "VARCHAR",
  agent_snapshot_date: "VARCHAR",
  snapshot_consistency: "VARCHAR",
  statewide_intersection_coverage_percent: "DOUBLE",
  county_scope_type: "VARCHAR",
  county_code: "VARCHAR",
  county_label: "VARCHAR",
};

const CID_PATTERN = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MANIFEST_TIMEOUT_MS = 12_000;

const ArtifactSchema = z
  .object({
    key: z.string(),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(SHA256_PATTERN),
    cid: z.string().regex(CID_PATTERN),
  })
  .strict();

/**
 * Fail-closed schema for the public organization-only manifest.
 *
 * Every semantic and privacy boundary is a literal or exact tuple. A producer
 * schema change therefore cannot silently expose a new column or weaken the
 * registered-agent-office interpretation.
 */
export const CorporateManifestSchema = z
  .object({
    schemaVersion: z.literal(CORPORATE_SCHEMA_VERSION),
    dataset: z.literal(CORPORATE_DATASET_NAME),
    exportedAt: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value)), {
        message: "exportedAt must be a valid timestamp",
      }),
    rowCount: z.number().int().positive(),
    uniqueIllinoisFileNumberCount: z.number().int().positive(),
    sourceSystem: z.literal("illinois_sos"),
    scope: z
      .object({
        type: z.literal("registered_agent_office_county"),
        countyCode: z.literal("081"),
        countyLabel: z.literal("Rock Island"),
        meaning: z.literal(
          "organization has a registered-agent office county code of 081",
        ),
        doesNotEstablish: z.tuple([
          z.literal("operating_location"),
          z.literal("tenancy"),
          z.literal("ownership"),
          z.literal("occupancy"),
        ]),
      })
      .strict(),
    componentSnapshots: z
      .object({
        master: z.string(),
        name: z.string(),
        agent: z.string(),
      })
      .strict(),
    snapshotConsistency: z.literal("mixed_date"),
    statewideIntersection: z
      .object({
        sourceCount: z.number().int().positive(),
        includedCount: z.number().int().positive(),
        excludedCount: z.number().int().nonnegative(),
        coveragePercent: z.literal(99.9933),
        excludedCounty081Count: z.literal(0),
      })
      .strict(),
    privacy: z
      .object({
        classification: z.literal("public_non_pii_organization_registry"),
        allowlistColumns: z.tuple(
          CORPORATE_PUBLIC_COLUMNS.map((column) => z.literal(column)) as [
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[0]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[1]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[2]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[3]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[4]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[5]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[6]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[7]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[8]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[9]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[10]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[11]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[12]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[13]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[14]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[15]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[16]>,
            z.ZodLiteral<(typeof CORPORATE_PUBLIC_COLUMNS)[17]>,
          ],
        ),
        excludedClasses: z.tuple([
          z.literal("registered_agent_names"),
          z.literal("officer_member_person_names"),
          z.literal("street_postal_email_phone_contact"),
          z.literal("raw_source_payloads"),
          z.literal("address_hashes"),
          z.literal("property_appraisal_links"),
          z.literal("complaints_reviews"),
        ]),
        semanticScanPassed: z.literal(true),
      })
      .strict(),
    dateAvailability: z
      .object({
        incorporationDate: z.literal(true),
        organizationDate: z.literal(false),
        dissolutionDate: z.literal(false),
      })
      .strict(),
    artifacts: z.tuple([ArtifactSchema, ArtifactSchema]),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.rowCount !== manifest.uniqueIllinoisFileNumberCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["uniqueIllinoisFileNumberCount"],
        message: "Corporate row and unique-file-number counts must agree",
      });
    }
    if (
      manifest.statewideIntersection.sourceCount -
        manifest.statewideIntersection.includedCount !==
      manifest.statewideIntersection.excludedCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["statewideIntersection"],
        message: "Corporate statewide intersection counts do not reconcile",
      });
    }
    if (manifest.artifacts[0].key !== CORPORATE_PARQUET_ARTIFACT_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts", 0, "key"],
        message: "Corporate manifest does not select the approved Parquet key",
      });
    }
    if (manifest.artifacts[1].key !== CORPORATE_SCHEMA_ARTIFACT_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts", 1, "key"],
        message:
          "Corporate manifest does not reference the approved schema key",
      });
    }
  });

export type CorporateManifest = z.infer<typeof CorporateManifestSchema>;

interface CorporateManifestCacheEntry {
  readonly manifest: CorporateManifest;
  readonly fetchedAt: number;
}

const manifestCache = new Map<string, CorporateManifestCacheEntry>();

/** Clear validated corporate-manifest cache entries. Intended for tests. */
export function clearCorporateManifestCache(): void {
  manifestCache.clear();
}

/**
 * Validate an already-parsed corporate manifest with the exact public contract.
 *
 * @param value - Unknown JSON value read from the public manifest.
 * @returns The validated, privacy-safe corporate manifest.
 * @throws {Error} When any schema, scope, privacy, or artifact field drifts.
 */
export function parseCorporateManifest(value: unknown): CorporateManifest {
  const parsed = CorporateManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Corporate manifest failed closed validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Read a corporate manifest from an HTTP(S) IPNS URL or local test path.
 *
 * @param location - Stable manifest location.
 * @returns Parsed JSON with no trust applied yet.
 */
async function readManifestJson(location: string): Promise<unknown> {
  if (/^https?:\/\//iu.test(location)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
    try {
      const response = await fetch(location, {
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Corporate manifest fetch returned HTTP ${response.status}`,
        );
      }
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(timeout);
    }
  }
  return JSON.parse(await readFile(location, "utf8")) as unknown;
}

/**
 * Fetch and validate the current corporate manifest behind a stable IPNS URL.
 * Only successful validations are cached, so transient or drift failures retry.
 *
 * @param location - Stable public manifest URL or local test path.
 * @returns Exact validated public corporate manifest.
 */
export async function fetchCorporateManifest(
  location: string,
): Promise<CorporateManifest> {
  const now = Date.now();
  const cached = manifestCache.get(location);
  if (cached !== undefined && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.manifest;
  }

  const manifest = parseCorporateManifest(await readManifestJson(location));
  manifestCache.set(location, { manifest, fetchedAt: now });
  return manifest;
}

/**
 * Resolve the current corporate Parquet by its CID from the validated manifest.
 *
 * HTTP manifests use the same gateway origin with an immutable `/ipfs/<cid>`
 * path. Local manifests resolve to their sibling Parquet for isolated tests.
 * The county key is checked against the explicit public allowlist before any
 * manifest or Parquet read occurs.
 *
 * @param manifestLocation - Stable IPNS manifest URL or local test path.
 * @param countyKey - Normalized requested county key.
 * @returns Immutable current Parquet location selected by the manifest.
 */
export async function resolveCorporateParquetLocation(
  manifestLocation: string,
  countyKey: string | null,
): Promise<string> {
  if (
    countyKey === null ||
    !(CORPORATE_ALLOWED_COUNTY_KEYS as readonly string[]).includes(countyKey)
  ) {
    throw new Error(
      `County '${countyKey ?? ""}' is not in the public corporate-registration allowlist.`,
    );
  }

  const manifest = await fetchCorporateManifest(manifestLocation);
  const parquetCid = manifest.artifacts[0].cid;
  if (/^https?:\/\//iu.test(manifestLocation)) {
    return new URL(`/ipfs/${parquetCid}`, manifestLocation).toString();
  }
  return join(dirname(manifestLocation), "corporate-registrations.parquet");
}
