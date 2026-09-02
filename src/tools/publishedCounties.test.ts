import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPublishedCountyCatalogCache,
  fetchPublishedCountyCatalog,
  getPublishedCountyCatalogLocation,
  getPublishedCountyCatalogRevision,
} from "../lib/publishedCountyCatalog.ts";
import type {
  PublishedCounty,
  PublishedCountyCatalog,
} from "../types/publishedCountyCatalog.ts";
import { listPublishedCountiesHandler } from "./publishedCounties.ts";

const publicationScopeFixture = JSON.parse(
  readFileSync(
    new URL("../../fixtures/publication-scope-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  scenarios: Array<{
    id: string;
    publicationScope: {
      schemaVersion: "1.0";
      level: "full" | "partial" | "pilot";
      denominatorBasis: "county_total" | "published_subset";
    };
  }>;
};

const catalog: PublishedCountyCatalog = {
  schemaVersion: "1.1",
  generatedAt: "2026-07-24T10:00:00.000Z",
  counties: [
    {
      countyKey: "palm-beach",
      countyName: "Palm Beach",
      stateCode: "FL",
      countyFips: "12099",
      status: "published",
      publicationScope: {
        schemaVersion: "1.0",
        level: "full",
        denominatorBasis: "county_total",
      },
      queryTableUrl: "https://example.com/palm-beach.parquet",
      datasetCoverageUrl: "https://example.com/palm-beach-coverage.json",
      permitQueryTableUrl: null,
      placesTableUrl: null,
      updatedAt: "2026-07-24T09:00:00.000Z",
    },
    {
      countyKey: "lee",
      countyName: "Lee",
      stateCode: "FL",
      countyFips: "12071",
      status: "published",
      publicationScope: {
        schemaVersion: "1.0",
        level: "full",
        denominatorBasis: "county_total",
      },
      queryTableUrl: "https://example.com/lee.parquet",
      datasetCoverageUrl: "https://example.com/lee-coverage.json",
      permitQueryTableUrl: null,
      placesTableUrl:
        "https://ipfs.filebase.io/ipns/k51places/lee/places-table.parquet",
      updatedAt: "2026-07-24T08:00:00.000Z",
    },
  ],
};

function scopeRegistryFor(counties: readonly PublishedCounty[]) {
  return {
    schemaVersion: "1.0",
    registryVersion: "test-1",
    owner: "elephant-mcp/donphan",
    reviewedAt: "2026-07-24T10:00:00.000Z",
    entries: counties.map((county) => ({
      countyKey: county.countyKey,
      countyName: county.countyName,
      stateCode: county.stateCode,
      countyFips: county.countyFips,
      queryTableIdentity: county.queryTableUrl,
      datasetCoverageIdentity: county.datasetCoverageUrl,
      publicationScope: county.publicationScope,
      provenance: {
        owner: "elephant-mcp/donphan",
        artifactCatalog: "https://example.com/catalog.json",
        classificationEvidence: "https://example.com/review/1",
        reviewedAt: "2026-07-24T10:00:00.000Z",
      },
    })),
  };
}

describe("published county catalog", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "published-counties-"));
    clearPublishedCountyCatalogCache();
    delete process.env.PUBLISHED_COUNTY_CATALOG_URL;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearPublishedCountyCatalogCache();
    delete process.env.PUBLISHED_COUNTY_CATALOG_URL;
    rmSync(directory, { recursive: true, force: true });
  });

  it("uses an explicit catalog location when configured", () => {
    process.env.PUBLISHED_COUNTY_CATALOG_URL = "/tmp/catalog.json";
    expect(getPublishedCountyCatalogLocation()).toBe("/tmp/catalog.json");
  });

  it("reads, validates, and sorts a local catalog", async () => {
    const file = join(directory, "catalog.json");
    writeFileSync(file, JSON.stringify(catalog));
    process.env.PUBLISHED_COUNTY_CATALOG_URL = file;

    const result = await fetchPublishedCountyCatalog();

    expect(result.counties.map((county) => county.countyKey)).toEqual([
      "lee",
      "palm-beach",
    ]);
  });

  it("rejects duplicate county keys", async () => {
    const file = join(directory, "duplicate.json");
    writeFileSync(
      file,
      JSON.stringify({
        ...catalog,
        counties: [catalog.counties[0], catalog.counties[0]],
      }),
    );
    process.env.PUBLISHED_COUNTY_CATALOG_URL = file;

    await expect(fetchPublishedCountyCatalog()).rejects.toThrow(
      "duplicate countyKey 'palm-beach'",
    );
  });

  it("returns the enumerated counties and a deterministic revision", async () => {
    const file = join(directory, "catalog.json");
    writeFileSync(file, JSON.stringify(catalog));
    process.env.PUBLISHED_COUNTY_CATALOG_URL = file;

    const registry = scopeRegistryFor(catalog.counties);
    const first = await listPublishedCountiesHandler({
      scopeRegistry: registry,
    });
    clearPublishedCountyCatalogCache();
    const second = await listPublishedCountiesHandler({
      scopeRegistry: registry,
    });
    const firstPayload = JSON.parse(first.content[0]?.text ?? "{}") as {
      countyCount: number;
      catalogRevision: string;
      counties: Array<{
        countyKey: string;
        placesTableUrl: string | null;
        publicationScope: {
          level: string;
          denominatorBasis: string;
        };
        publicationScopeResolution: {
          reason: string;
          registryRevision: string;
        };
      }>;
      scopeRegistryVersion: string;
      scopeRegistryRevision: string;
    };
    const secondPayload = JSON.parse(second.content[0]?.text ?? "{}") as {
      catalogRevision: string;
    };

    expect(firstPayload.countyCount).toBe(2);
    expect(firstPayload.counties[0]?.countyKey).toBe("lee");
    expect(firstPayload.counties[0]?.placesTableUrl).toContain(
      "/lee/places-table.parquet",
    );
    expect(firstPayload.counties[0]?.publicationScope).toEqual({
      schemaVersion: "1.0",
      level: "full",
      denominatorBasis: "county_total",
    });
    expect(firstPayload.counties[0]?.publicationScopeResolution.reason).toBe(
      "registry_match",
    );
    expect(firstPayload.scopeRegistryVersion).toBe("test-1");
    expect(firstPayload.scopeRegistryRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(firstPayload.counties[1]?.placesTableUrl).toBeNull();
    expect(firstPayload.catalogRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(secondPayload.catalogRevision).toBe(firstPayload.catalogRevision);
  });

  it("preserves the shared Hillsborough pilot scope fixture", async () => {
    const pilot = publicationScopeFixture.scenarios.find(
      (scenario) => scenario.id === "hillsborough-50-of-50-pilot",
    );
    expect(pilot).toBeDefined();
    const file = join(directory, "pilot-catalog.json");
    writeFileSync(
      file,
      JSON.stringify({
        ...catalog,
        counties: [
          {
            ...catalog.counties[0],
            countyKey: "hillsborough",
            countyName: "Hillsborough",
            countyFips: "12057",
            publicationScope: pilot!.publicationScope,
          },
        ],
      }),
    );
    process.env.PUBLISHED_COUNTY_CATALOG_URL = file;

    const pilotCounty = {
      ...catalog.counties[0],
      countyKey: "hillsborough",
      countyName: "Hillsborough",
      countyFips: "12057",
      publicationScope: pilot!.publicationScope,
    };
    const result = await listPublishedCountiesHandler({
      scopeRegistry: scopeRegistryFor([pilotCounty]),
    });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      counties: Array<{
        publicationScope: unknown;
        publicationScopeResolution: { reason: string };
      }>;
    };

    expect(payload.counties[0]?.publicationScope).toEqual(
      pilot!.publicationScope,
    );
    expect(payload.counties[0]?.publicationScopeResolution.reason).toBe(
      "registry_match",
    );
  });

  it("binds scope transitions into the catalog revision", () => {
    const fullRevision = getPublishedCountyCatalogRevision(catalog);
    const transitioned = {
      ...catalog,
      counties: catalog.counties.map((county, index) =>
        index === 0
          ? {
              ...county,
              publicationScope: {
                schemaVersion: "1.0" as const,
                level: "partial" as const,
                denominatorBasis: "county_total" as const,
              },
            }
          : county,
      ),
    };

    expect(getPublishedCountyCatalogRevision(transitioned)).not.toBe(
      fullRevision,
    );
  });

  it("fails closed on missing or unsupported scope in schema 1.1", async () => {
    const file = join(directory, "invalid-scope.json");
    const missingScope: {
      publicationScope?: unknown;
      [key: string]: unknown;
    } = { ...catalog.counties[0] };
    delete missingScope.publicationScope;
    writeFileSync(
      file,
      JSON.stringify({ ...catalog, counties: [missingScope] }),
    );
    process.env.PUBLISHED_COUNTY_CATALOG_URL = file;
    await expect(fetchPublishedCountyCatalog()).rejects.toThrow(
      "requires explicit publicationScope",
    );

    clearPublishedCountyCatalogCache();
    writeFileSync(
      file,
      JSON.stringify({
        ...catalog,
        counties: [
          {
            ...catalog.counties[0],
            publicationScope: {
              schemaVersion: "1.0",
              level: "unknown",
              denominatorBasis: "county_total",
            },
          },
        ],
      }),
    );
    await expect(fetchPublishedCountyCatalog()).rejects.toThrow(
      "catalog schema validation failed",
    );
  });

  it("returns a structured error when the catalog is invalid", async () => {
    const file = join(directory, "invalid.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: "wrong" }));
    process.env.PUBLISHED_COUNTY_CATALOG_URL = file;

    const result = await listPublishedCountiesHandler();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      error?: string;
    };

    expect(payload.error).toBe(
      "Failed to read the canonical published-county catalog",
    );
    expect(result.isError).toBe(true);
  });
});
