import { describe, expect, it } from "vitest";

import registryJson from "../data/publication-scope-registry-v1.json";
import type { PublishedCounty } from "../types/publishedCountyCatalog.ts";
import {
  getPublicationScopeRegistryRevision,
  PUBLICATION_SCOPE_REGISTRY,
  resolvePublicationScope,
} from "./publicationScopeRegistry.ts";

const reviewedAt = "2026-09-01T17:06:37.000Z";

function county(overrides: Partial<PublishedCounty> = {}): PublishedCounty {
  return {
    countyKey: "lee",
    countyName: "Lee",
    stateCode: "FL",
    countyFips: "12071",
    status: "published",
    queryTableUrl:
      "https://ipfs.filebase.io/ipns/k51qzi5uqu5djd4ohcf3qm87dhlt0e270xw8ejhkyia62edr76uj0u05hrf7m5",
    datasetCoverageUrl:
      "https://k51qzi5uqu5dimw0elyh4agbtqe7v2fzp0jcd7b1bcu8kxs0hml7yu1no0z0vd.ipns.dweb.link/",
    permitQueryTableUrl: null,
    placesTableUrl: null,
    updatedAt: reviewedAt,
    ...overrides,
  };
}

function syntheticRegistry(level: "full" | "partial" | "pilot" = "full") {
  return {
    schemaVersion: "1.0",
    registryVersion: "test-1",
    owner: "elephant-mcp/donphan",
    reviewedAt,
    entries: [
      {
        countyKey: "lee",
        countyName: "Lee",
        stateCode: "FL",
        countyFips: "12071",
        queryTableIdentity: "https://example.com/lee/query",
        datasetCoverageIdentity: "https://example.com/lee/coverage",
        publicationScope: {
          schemaVersion: "1.0",
          level,
          denominatorBasis:
            level === "pilot" ? "published_subset" : "county_total",
        },
        provenance: {
          owner: "elephant-mcp/donphan",
          artifactCatalog: "https://example.com/catalog.json",
          classificationEvidence: "https://example.com/review/1",
          reviewedAt,
        },
      },
    ],
  };
}

describe("Donphan publication-scope registry", () => {
  it("contains twelve county identities with Broward explicitly partial", () => {
    expect(registryJson.entries).toHaveLength(12);
    expect(
      registryJson.entries
        .filter((entry) => entry.publicationScope.level === "full")
        .map((entry) => entry.countyKey),
    ).toEqual([
      "hillsborough",
      "lee",
      "miami-dade",
      "montgomery",
      "orange",
      "palm-beach",
      "polk",
      "rock-island",
      "seminole",
    ]);
    expect(
      registryJson.entries
        .filter((entry) => entry.publicationScope.level === "pilot")
        .map((entry) => entry.countyKey),
    ).toEqual(["chester", "pinellas"]);
    expect(
      registryJson.entries
        .filter((entry) => entry.publicationScope.level === "partial")
        .map((entry) => entry.countyKey),
    ).toEqual(["broward"]);
  });

  it("resolves a registry-bound full county across equivalent IPNS URL forms", () => {
    const result = resolvePublicationScope(county());

    expect(result.publicationScope).toMatchObject({
      level: "full",
      denominatorBasis: "county_total",
    });
    expect(result.resolution).toMatchObject({
      reason: "registry_match",
      registryVersion: "2026-09-03.1",
      registryRevision: getPublicationScopeRegistryRevision(),
      entryIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
      provenance: { owner: "elephant-mcp/donphan" },
    });
  });

  it("resolves Broward as partial only for its reviewed artifact identities", () => {
    const result = resolvePublicationScope(
      county({
        countyKey: "broward",
        countyName: "Broward",
        countyFips: "12011",
        queryTableUrl:
          "https://ipfs.filebase.io/ipns/k51qzi5uqu5dibuhwyztmkjgvz94v3mkpgfreryxwb3d4neta5e7tsxebfi09s",
        datasetCoverageUrl:
          "https://ipfs.filebase.io/ipns/k51qzi5uqu5dhx6yqczp6f9na3xa9g1iiizxtquer62x9wavh8gpbng524vrbp",
        permitQueryTableUrl:
          "https://ipfs.filebase.io/ipns/k51qzi5uqu5dhns9u4o0lot4w4808yi4gdsyo5qx136lgmrplmgqdhah5qj7lg",
      }),
    );

    expect(result.publicationScope).toEqual({
      schemaVersion: "1.0",
      level: "partial",
      denominatorBasis: "county_total",
    });
    expect(result.resolution.reason).toBe("registry_match");
  });

  it("resolves Seminole as full for its reviewed CAMA artifact identities", () => {
    const result = resolvePublicationScope(
      county({
        countyKey: "seminole",
        countyName: "Seminole",
        countyFips: "12117",
        queryTableUrl:
          "https://ipfs.filebase.io/ipns/k51qzi5uqu5di6kqptmkfaoq7yxc7z04spm1n0gbrc26toi2eah1b66cfrqfwp",
        datasetCoverageUrl:
          "https://ipfs.filebase.io/ipns/k51qzi5uqu5dmawnn59hx0z87i36xk60os0vur3m05p8u2ial89cn2oay7o9oz",
      }),
    );

    expect(result.publicationScope).toEqual({
      schemaVersion: "1.0",
      level: "full",
      denominatorBasis: "county_total",
    });
    expect(result.resolution.reason).toBe("registry_match");
  });

  it.each([
    [
      "missing entry",
      county({ countyKey: "new-county" }),
      "registry_entry_missing",
    ],
    [
      "artifact identity drift",
      county({ queryTableUrl: "https://example.com/drifted" }),
      "registry_identity_mismatch",
    ],
  ])("fails closed for %s", (_label, input, reason) => {
    const result = resolvePublicationScope(input);
    expect(result.publicationScope).toBeNull();
    expect(result.resolution.reason).toBe(reason);
  });

  it("fails closed on malformed and duplicate registry entries", () => {
    const malformed = syntheticRegistry();
    malformed.entries[0]!.publicationScope.level = "unknown" as "full";
    expect(
      resolvePublicationScope(
        county({
          queryTableUrl: "https://example.com/lee/query",
          datasetCoverageUrl: "https://example.com/lee/coverage",
        }),
        { registry: malformed },
      ).resolution.reason,
    ).toBe("registry_entry_malformed");

    const duplicate = syntheticRegistry();
    duplicate.entries.push({ ...duplicate.entries[0]! });
    expect(
      resolvePublicationScope(
        county({
          queryTableUrl: "https://example.com/lee/query",
          datasetCoverageUrl: "https://example.com/lee/coverage",
        }),
        { registry: duplicate },
      ).resolution.reason,
    ).toBe("registry_entry_conflict");
  });

  it("rejects explicit-source conflicts instead of trusting either source", () => {
    const result = resolvePublicationScope(county(), {
      explicitScopes: [
        {
          source: "catalog",
          value: {
            schemaVersion: "1.0",
            level: "pilot",
            denominatorBasis: "published_subset",
          },
        },
      ],
    });

    expect(result.publicationScope).toBeNull();
    expect(result.resolution.reason).toBe("explicit_source_scope_conflict");
  });

  it("isolates registry revisions and makes a partial-to-full transition explicit", () => {
    const source = syntheticRegistry("partial");
    const transitioned = {
      ...source,
      registryVersion: "test-2",
      entries: source.entries.map((entry) => ({
        ...entry,
        publicationScope: {
          schemaVersion: "1.0",
          level: "full",
          denominatorBasis: "county_total",
        },
      })),
    };
    const catalogCounty = county({
      queryTableUrl: "https://example.com/lee/query",
      datasetCoverageUrl: "https://example.com/lee/coverage",
    });

    expect(
      resolvePublicationScope(catalogCounty, { registry: source })
        .publicationScope?.level,
    ).toBe("partial");
    expect(
      resolvePublicationScope(catalogCounty, { registry: transitioned })
        .publicationScope?.level,
    ).toBe("full");
    expect(getPublicationScopeRegistryRevision(source)).not.toBe(
      getPublicationScopeRegistryRevision(transitioned),
    );
  });

  it("fails closed when runtime artifacts drift from the registry", () => {
    const result = resolvePublicationScope(county(), {
      runtimeArtifacts: {
        queryTableUrl: "https://example.com/drifted",
        datasetCoverageUrl: county().datasetCoverageUrl,
      },
    });

    expect(result.publicationScope).toBeNull();
    expect(result.resolution.reason).toBe("runtime_artifact_identity_mismatch");
  });

  it("keeps the bundled registry content-addressed", () => {
    expect(
      getPublicationScopeRegistryRevision(PUBLICATION_SCOPE_REGISTRY),
    ).toMatch(/^[a-f0-9]{64}$/);
  });
});
