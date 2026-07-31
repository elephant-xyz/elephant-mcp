import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPublishedCountyCatalogCache,
  fetchPublishedCountyCatalog,
  getPublishedCountyCatalogLocation,
} from "../lib/publishedCountyCatalog.ts";
import { listPublishedCountiesHandler } from "./publishedCounties.ts";

const catalog = {
  schemaVersion: "1.0",
  generatedAt: "2026-07-24T10:00:00.000Z",
  counties: [
    {
      countyKey: "palm-beach",
      countyName: "Palm Beach",
      stateCode: "FL",
      countyFips: "12099",
      status: "published",
      queryTableUrl: "https://example.com/palm-beach.parquet",
      datasetCoverageUrl: "https://example.com/palm-beach-coverage.json",
      permitQueryTableUrl: null,
      updatedAt: "2026-07-24T09:00:00.000Z",
    },
    {
      countyKey: "lee",
      countyName: "Lee",
      stateCode: "FL",
      countyFips: "12071",
      status: "published",
      queryTableUrl: "https://example.com/lee.parquet",
      datasetCoverageUrl: "https://example.com/lee-coverage.json",
      permitQueryTableUrl: null,
      updatedAt: "2026-07-24T08:00:00.000Z",
    },
  ],
} as const;

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

    const first = await listPublishedCountiesHandler();
    clearPublishedCountyCatalogCache();
    const second = await listPublishedCountiesHandler();
    const firstPayload = JSON.parse(first.content[0]?.text ?? "{}") as {
      countyCount: number;
      catalogRevision: string;
      counties: Array<{ countyKey: string }>;
    };
    const secondPayload = JSON.parse(second.content[0]?.text ?? "{}") as {
      catalogRevision: string;
    };

    expect(firstPayload.countyCount).toBe(2);
    expect(firstPayload.counties[0]?.countyKey).toBe("lee");
    expect(firstPayload.catalogRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(secondPayload.catalogRevision).toBe(firstPayload.catalogRevision);
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
