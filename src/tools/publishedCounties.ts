import {
  fetchPublishedCountyCatalog,
  getPublishedCountyCatalogRevision,
} from "../lib/publishedCountyCatalog.ts";
import {
  getPublicationScopeRegistryRevision,
  getPublicationScopeRegistryVersion,
  resolvePublicationScope,
} from "../lib/publicationScopeRegistry.ts";
import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";

interface ListPublishedCountiesOptions {
  readonly scopeRegistry?: unknown;
}

/**
 * Enumerate every Oracle county whose public data artifacts have been
 * published, then resolve its publication scope from Donphan's registry.
 */
export async function listPublishedCountiesHandler(
  options: ListPublishedCountiesOptions = {},
) {
  try {
    const catalog = await fetchPublishedCountyCatalog();
    const catalogRevision = getPublishedCountyCatalogRevision(catalog);
    const scopeRegistryRevision = getPublicationScopeRegistryRevision(
      options.scopeRegistry,
    );
    const scopeRegistryVersion = getPublicationScopeRegistryVersion(
      options.scopeRegistry,
    );
    return createTextResult({
      schemaVersion: catalog.schemaVersion,
      generatedAt: catalog.generatedAt,
      catalogRevision,
      scopeRegistryVersion,
      scopeRegistryRevision,
      countyCount: catalog.counties.length,
      counties: catalog.counties.map((county) => {
        const explicitScopes =
          county.publicationScope === undefined
            ? []
            : [{ source: "catalog", value: county.publicationScope }];
        const resolved = resolvePublicationScope(county, {
          registry: options.scopeRegistry,
          explicitScopes,
        });
        return {
          ...county,
          publicationScope: resolved.publicationScope,
          publicationScopeResolution: resolved.resolution,
        };
      }),
    });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "listPublishedCounties failed",
    );
    return {
      ...createTextResult({
        error: "Failed to read the canonical published-county catalog",
        details: error instanceof Error ? error.message : String(error),
      }),
      isError: true,
    };
  }
}
