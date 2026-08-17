import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CORPORATE_PUBLIC_COLUMNS,
  clearCorporateManifestCache,
  parseCorporateManifest,
  resolveCorporateParquetLocation,
} from "./corporateManifest.ts";

const MANIFEST_URL =
  "https://ipfs.filebase.io/ipns/k51qzi5uqu5dggdjnm0bym1p10gtu3o7dz3ipfaa4ccxgs73oohaqndzegk16d";
const PARQUET_CID = "QmY44DzhzYcTBjVbjQhDYdcpfMCoPpPFcUs8tjuk7cCbqJ";
const SCHEMA_CID = "QmWxP8FaU2KQ4fsrrEnjTTNVxjvzQscLtwskZFdmopSwMJ";

/**
 * Build the exact published manifest shape without reading the network.
 *
 * @returns Mutable fixture matching the approved public contract.
 */
function buildManifestFixture() {
  return {
    schemaVersion: "illinois-sos-rock-island-corporate-registration-public-v1",
    dataset: "rock_island_corporate_registrations",
    exportedAt: "2026-08-14T17:40:00.000Z",
    rowCount: 11741,
    uniqueIllinoisFileNumberCount: 11741,
    sourceSystem: "illinois_sos",
    scope: {
      type: "registered_agent_office_county",
      countyCode: "081",
      countyLabel: "Rock Island",
      meaning: "organization has a registered-agent office county code of 081",
      doesNotEstablish: [
        "operating_location",
        "tenancy",
        "ownership",
        "occupancy",
      ],
    },
    componentSnapshots: {
      master: "2026-07-29",
      name: "2026-07-28",
      agent: "2026-07-29",
    },
    snapshotConsistency: "mixed_date",
    statewideIntersection: {
      sourceCount: 1981387,
      includedCount: 1981254,
      excludedCount: 133,
      coveragePercent: 99.9933,
      excludedCounty081Count: 0,
    },
    privacy: {
      classification: "public_non_pii_organization_registry",
      allowlistColumns: [...CORPORATE_PUBLIC_COLUMNS],
      excludedClasses: [
        "registered_agent_names",
        "officer_member_person_names",
        "street_postal_email_phone_contact",
        "raw_source_payloads",
        "address_hashes",
        "property_appraisal_links",
        "complaints_reviews",
      ],
      semanticScanPassed: true,
    },
    dateAvailability: {
      incorporationDate: true,
      organizationDate: false,
      dissolutionDate: false,
    },
    artifacts: [
      {
        key: "corporate-registrations/rock-island/corporate-registrations.parquet",
        bytes: 2953180,
        sha256:
          "a2c9e6361eda613d51010badbf5449370665c5bc8e993c4162ef327d102215a6",
        cid: PARQUET_CID,
      },
      {
        key: "corporate-registrations/rock-island/corporate-registration-schema.json",
        bytes: 2263,
        sha256:
          "048846c0f998797cb867032ea10cf4a885ce13710b11080aca9f77045432246a",
        cid: SCHEMA_CID,
      },
    ],
  };
}

afterEach(() => {
  clearCorporateManifestCache();
  vi.restoreAllMocks();
});

describe("public corporate manifest", () => {
  it("accepts the exact safe published contract", () => {
    const manifest = parseCorporateManifest(buildManifestFixture());

    expect(manifest.rowCount).toBe(11741);
    expect(manifest.privacy.allowlistColumns).toEqual(CORPORATE_PUBLIC_COLUMNS);
    expect(manifest.scope.type).toBe("registered_agent_office_county");
  });

  it("fails closed when a producer adds an unapproved column", () => {
    const manifest = buildManifestFixture();
    const driftedColumns: string[] = manifest.privacy.allowlistColumns;
    driftedColumns.push("private_hidden_field");

    expect(() => parseCorporateManifest(manifest)).toThrow(
      "failed closed validation",
    );
  });

  it("fails closed on weakened county semantics or count drift", () => {
    const scopeDrift = buildManifestFixture();
    scopeDrift.scope.type = "operating_location";
    expect(() => parseCorporateManifest(scopeDrift)).toThrow(
      "failed closed validation",
    );

    const countDrift = buildManifestFixture();
    countDrift.uniqueIllinoisFileNumberCount = 11740;
    expect(() => parseCorporateManifest(countDrift)).toThrow(
      "unique-file-number counts must agree",
    );
  });

  it("resolves the immutable Parquet CID from stable IPNS and caches success", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(buildManifestFixture()), { status: 200 }),
      );

    await expect(
      resolveCorporateParquetLocation(MANIFEST_URL, "rock-island"),
    ).resolves.toBe(`https://ipfs.filebase.io/ipfs/${PARQUET_CID}`);
    await resolveCorporateParquetLocation(MANIFEST_URL, "rock-island");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a county outside the allowlist before fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      resolveCorporateParquetLocation(MANIFEST_URL, "lee"),
    ).rejects.toThrow("not in the public corporate-registration allowlist");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
