import { createHash } from "node:crypto";

import { z } from "zod";

import registryJson from "../data/publication-scope-registry-v1.json";
import {
  PublicationScopeSchema,
  type PublicationScope,
  type PublishedCounty,
} from "../types/publishedCountyCatalog.ts";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const PublicationScopeProvenanceSchema = z
  .object({
    owner: z.literal("elephant-mcp/donphan"),
    artifactCatalog: z.string().url(),
    classificationEvidence: z.string().url(),
    reviewedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const PublicationScopeArtifactIdentitySchema = z
  .object({
    countyKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    countyName: z.string().min(1),
    stateCode: z.string().regex(/^[A-Z]{2}$/),
    countyFips: z.string().regex(/^\d{5}$/),
    queryTableIdentity: z.string().min(1),
    datasetCoverageIdentity: z.string().min(1),
  })
  .strict();

const PublicationScopeRegistryEntrySchema =
  PublicationScopeArtifactIdentitySchema.extend({
    publicationScope: PublicationScopeSchema,
    provenance: PublicationScopeProvenanceSchema,
  }).strict();

const PublicationScopeRegistryHeaderSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    registryVersion: z.string().min(1),
    owner: z.literal("elephant-mcp/donphan"),
    reviewedAt: z.string().datetime({ offset: true }),
    entries: z.array(z.unknown()),
  })
  .strict();

export const PublicationScopeResolutionReasonSchema = z.enum([
  "registry_match",
  "catalog_unavailable",
  "registry_invalid",
  "registry_entry_missing",
  "registry_entry_malformed",
  "registry_entry_conflict",
  "registry_identity_mismatch",
  "runtime_artifact_identity_mismatch",
  "explicit_source_scope_invalid",
  "explicit_source_scope_conflict",
]);

export const PublicationScopeResolutionSchema = z
  .object({
    reason: PublicationScopeResolutionReasonSchema,
    registryVersion: z.string().min(1).nullable(),
    registryRevision: sha256Schema,
    entryIdentity: sha256Schema.nullable(),
    artifactIdentity: PublicationScopeArtifactIdentitySchema.nullable(),
    provenance: PublicationScopeProvenanceSchema.nullable(),
  })
  .strict();

export type PublicationScopeResolution = z.infer<
  typeof PublicationScopeResolutionSchema
>;

export interface ResolvedPublicationScope {
  readonly publicationScope: PublicationScope | null;
  readonly resolution: PublicationScopeResolution;
}

export interface ExplicitPublicationScope {
  readonly source: string;
  readonly value: unknown;
}

interface ResolvePublicationScopeOptions {
  readonly registry?: unknown;
  readonly catalogUnavailable?: boolean;
  readonly explicitScopes?: readonly ExplicitPublicationScope[];
  readonly runtimeArtifacts?: {
    readonly queryTableUrl: string | null;
    readonly datasetCoverageUrl: string | null;
  };
}

export const PUBLICATION_SCOPE_REGISTRY: unknown = registryJson;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Normalize the two trusted public IPNS URL forms to one stable identity.
 * Other locations remain exact apart from a trailing slash.
 */
export function publicArtifactIdentity(location: string): string {
  try {
    const url = new URL(location);
    const hostname = url.hostname.toLowerCase();
    const pathSegments = url.pathname.split("/").filter(Boolean);
    if (
      hostname === "ipfs.filebase.io" &&
      pathSegments[0]?.toLowerCase() === "ipns" &&
      pathSegments[1]
    ) {
      return `ipns:${pathSegments.slice(1).join("/")}`;
    }
    const dwebSuffix = ".ipns.dweb.link";
    if (hostname.endsWith(dwebSuffix)) {
      const ipnsName = hostname.slice(0, -dwebSuffix.length);
      return `ipns:${[ipnsName, ...pathSegments].join("/")}`;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return location.replace(/\/$/, "");
  }
}

export function getPublicationScopeRegistryRevision(
  registry: unknown = PUBLICATION_SCOPE_REGISTRY,
): string {
  return sha256(registry);
}

export function getPublicationScopeRegistryVersion(
  registry: unknown = PUBLICATION_SCOPE_REGISTRY,
): string | null {
  const header = PublicationScopeRegistryHeaderSchema.safeParse(registry);
  return header.success ? header.data.registryVersion : null;
}

function scopesEqual(left: PublicationScope, right: PublicationScope): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.level === right.level &&
    left.denominatorBasis === right.denominatorBasis
  );
}

function unknownResolution(
  reason: PublicationScopeResolution["reason"],
  registryRevision: string,
  registryVersion: string | null,
  entry: z.infer<typeof PublicationScopeRegistryEntrySchema> | null = null,
): ResolvedPublicationScope {
  const artifactIdentity =
    entry === null
      ? null
      : PublicationScopeArtifactIdentitySchema.parse({
          countyKey: entry.countyKey,
          countyName: entry.countyName,
          stateCode: entry.stateCode,
          countyFips: entry.countyFips,
          queryTableIdentity: entry.queryTableIdentity,
          datasetCoverageIdentity: entry.datasetCoverageIdentity,
        });
  return {
    publicationScope: null,
    resolution: PublicationScopeResolutionSchema.parse({
      reason,
      registryVersion,
      registryRevision,
      entryIdentity: entry === null ? null : sha256(entry),
      artifactIdentity,
      provenance: entry?.provenance ?? null,
    }),
  };
}

/**
 * Resolve one catalog county against the Donphan-owned registry. Every
 * malformed, missing, drifting, or conflicting case returns unknown.
 */
export function resolvePublicationScope(
  county: PublishedCounty | null,
  options: ResolvePublicationScopeOptions = {},
): ResolvedPublicationScope {
  const registry = options.registry ?? PUBLICATION_SCOPE_REGISTRY;
  const registryRevision = getPublicationScopeRegistryRevision(registry);
  const header = PublicationScopeRegistryHeaderSchema.safeParse(registry);
  const registryVersion = header.success
    ? header.data.registryVersion
    : getPublicationScopeRegistryVersion(registry);
  if (!header.success) {
    return unknownResolution(
      "registry_invalid",
      registryRevision,
      registryVersion,
    );
  }
  if (options.catalogUnavailable === true) {
    return unknownResolution(
      "catalog_unavailable",
      registryRevision,
      registryVersion,
    );
  }
  if (county === null) {
    return unknownResolution(
      "registry_entry_missing",
      registryRevision,
      registryVersion,
    );
  }

  const candidates = header.data.entries.filter(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).countyKey === county.countyKey,
  );
  if (candidates.length === 0) {
    return unknownResolution(
      "registry_entry_missing",
      registryRevision,
      registryVersion,
    );
  }
  if (candidates.length > 1) {
    return unknownResolution(
      "registry_entry_conflict",
      registryRevision,
      registryVersion,
    );
  }
  const parsedEntry = PublicationScopeRegistryEntrySchema.safeParse(
    candidates[0],
  );
  if (!parsedEntry.success) {
    return unknownResolution(
      "registry_entry_malformed",
      registryRevision,
      registryVersion,
    );
  }
  const entry = parsedEntry.data;
  const actualIdentity = PublicationScopeArtifactIdentitySchema.parse({
    countyKey: county.countyKey,
    countyName: county.countyName,
    stateCode: county.stateCode,
    countyFips: county.countyFips,
    queryTableIdentity: publicArtifactIdentity(county.queryTableUrl),
    datasetCoverageIdentity: publicArtifactIdentity(county.datasetCoverageUrl),
  });
  const expectedIdentity = PublicationScopeArtifactIdentitySchema.parse({
    countyKey: entry.countyKey,
    countyName: entry.countyName,
    stateCode: entry.stateCode,
    countyFips: entry.countyFips,
    queryTableIdentity: entry.queryTableIdentity,
    datasetCoverageIdentity: entry.datasetCoverageIdentity,
  });
  if (sha256(actualIdentity) !== sha256(expectedIdentity)) {
    return unknownResolution(
      "registry_identity_mismatch",
      registryRevision,
      registryVersion,
      entry,
    );
  }

  if (options.runtimeArtifacts !== undefined) {
    const runtimeQueryIdentity =
      options.runtimeArtifacts.queryTableUrl === null
        ? null
        : publicArtifactIdentity(options.runtimeArtifacts.queryTableUrl);
    const runtimeCoverageIdentity =
      options.runtimeArtifacts.datasetCoverageUrl === null
        ? null
        : publicArtifactIdentity(options.runtimeArtifacts.datasetCoverageUrl);
    if (
      runtimeQueryIdentity !== entry.queryTableIdentity ||
      runtimeCoverageIdentity !== entry.datasetCoverageIdentity
    ) {
      return unknownResolution(
        "runtime_artifact_identity_mismatch",
        registryRevision,
        registryVersion,
        entry,
      );
    }
  }

  for (const explicit of options.explicitScopes ?? []) {
    const parsedScope = PublicationScopeSchema.safeParse(explicit.value);
    if (!parsedScope.success) {
      return unknownResolution(
        "explicit_source_scope_invalid",
        registryRevision,
        registryVersion,
        entry,
      );
    }
    if (!scopesEqual(parsedScope.data, entry.publicationScope)) {
      return unknownResolution(
        "explicit_source_scope_conflict",
        registryRevision,
        registryVersion,
        entry,
      );
    }
  }

  return {
    publicationScope: entry.publicationScope,
    resolution: PublicationScopeResolutionSchema.parse({
      reason: "registry_match",
      registryVersion,
      registryRevision,
      entryIdentity: sha256(entry),
      artifactIdentity: expectedIdentity,
      provenance: entry.provenance,
    }),
  };
}
