import { readFile } from "node:fs/promises";

import { logger } from "../logger.ts";
import {
  PublishedCountyCatalogSchema,
  type PublishedCountyCatalog,
} from "../types/publishedCountyCatalog.ts";

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;

export const DEFAULT_PUBLISHED_COUNTY_CATALOG_URL =
  "https://raw.githubusercontent.com/elephant-xyz/oracle-node/main/catalog/published-counties.json";

interface CatalogCacheEntry {
  readonly source: string;
  readonly catalog: PublishedCountyCatalog;
  readonly fetchedAt: number;
}

let catalogCache: CatalogCacheEntry | null = null;

/** Reset the published county catalog cache. Intended for tests. */
export function clearPublishedCountyCatalogCache(): void {
  catalogCache = null;
}

/** Resolve the canonical catalog location from configuration. */
export function getPublishedCountyCatalogLocation(): string {
  return (
    process.env.PUBLISHED_COUNTY_CATALOG_URL?.trim() ||
    DEFAULT_PUBLISHED_COUNTY_CATALOG_URL
  );
}

function isHttpLocation(location: string): boolean {
  return /^https?:\/\//i.test(location);
}

async function readCatalogJson(location: string): Promise<unknown> {
  if (!isHttpLocation(location)) {
    return JSON.parse(await readFile(location, "utf8")) as unknown;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(location, {
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`catalog fetch returned HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

function validateCatalog(raw: unknown): PublishedCountyCatalog {
  const parsed = PublishedCountyCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `catalog schema validation failed: ${parsed.error.message}`,
    );
  }

  const seen = new Set<string>();
  const seenFips = new Set<string>();
  for (const county of parsed.data.counties) {
    if (seen.has(county.countyKey)) {
      throw new Error(
        `catalog contains duplicate countyKey '${county.countyKey}'`,
      );
    }
    seen.add(county.countyKey);
    if (seenFips.has(county.countyFips)) {
      throw new Error(
        `catalog contains duplicate countyFips '${county.countyFips}'`,
      );
    }
    seenFips.add(county.countyFips);
  }

  return {
    ...parsed.data,
    counties: [...parsed.data.counties].sort((a, b) =>
      a.countyKey.localeCompare(b.countyKey),
    ),
  };
}

/**
 * Fetch and validate the canonical Oracle-published county catalog.
 *
 * Successful reads are cached briefly. Failures are not cached so a transient
 * GitHub/network error can recover on the next request.
 */
export async function fetchPublishedCountyCatalog(): Promise<PublishedCountyCatalog> {
  const source = getPublishedCountyCatalogLocation();
  const now = Date.now();
  if (
    catalogCache !== null &&
    catalogCache.source === source &&
    now - catalogCache.fetchedAt < CACHE_TTL_MS
  ) {
    return catalogCache.catalog;
  }

  try {
    const catalog = validateCatalog(await readCatalogJson(source));
    catalogCache = { source, catalog, fetchedAt: now };
    return catalog;
  } catch (error) {
    logger.warn(
      {
        source,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to read published county catalog",
    );
    throw error;
  }
}
