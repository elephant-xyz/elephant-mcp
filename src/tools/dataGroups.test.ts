import {
    extractClassPairs,
    shouldIgnoreClass,
    resolveDataGroup,
    listClassesFromDataGroup,
} from "./dataGroups.ts";
import { fetchManifest, normalizeKey } from "../lib/manifest.ts";

import type { Manifest } from "../types/lexicon.ts";

// Mock IPFS JSON fetcher
vi.mock("../lib/ipfs.ts", () => ({
    getJsonByCid: vi.fn(),
}));

const { getJsonByCid } = await import("../lib/ipfs.ts");

describe("helpers", () => {
    it("normalizeKey lowercases and trims", () => {
        expect(normalizeKey("  ABC  ")).toBe("abc");
    });

    it("extractClassPairs handles _has_", () => {
        expect(extractClassPairs("company_has_property")).toEqual([
            "company",
            "property",
        ]);
    });

    it("extractClassPairs handles _to_", () => {
        expect(extractClassPairs("tax_to_file")).toEqual(["tax", "file"]);
    });

    it("extractClassPairs returns null for unsupported pattern", () => {
        expect(extractClassPairs("invalid_relation")).toBe(null);
    });

    it("shouldIgnoreClass ignores fact_sheet variants", () => {
        expect(shouldIgnoreClass("fact_sheet")).toBe(true);
        expect(shouldIgnoreClass("Fact_Sheet")).toBe(true);
        expect(shouldIgnoreClass("factsheet")).toBe(true);
        expect(shouldIgnoreClass("school")).toBe(false);
    });
});

describe("resolveDataGroup", () => {
    const manifest: Manifest = {
        Seed: { ipfsCid: "cid-seed", type: "dataGroup" },
        School: { ipfsCid: "cid-school", type: "dataGroup" },
        property: { ipfsCid: "cid-property", type: "class" },
    };

    it("resolves by case-insensitive name", async () => {
        const res = await resolveDataGroup(manifest, "school");
        expect(res.key).toBe("School");
        expect(res.cid).toBe("cid-school");
        expect(res.available).toContain("Seed");
    });

    it("returns available data groups when not found", async () => {
        const res = await resolveDataGroup(manifest, "unknown");
        expect(res.key).toBe("");
        expect(res.available.sort()).toEqual(["School", "Seed"].sort());
    });
});

describe("listClassesFromDataGroup", () => {
    const manifest: Manifest = {
        property: { ipfsCid: "cid-property", type: "class" },
        company: { ipfsCid: "cid-company", type: "class" },
        file: { ipfsCid: "cid-file", type: "class" },
        school: { ipfsCid: "cid-school", type: "class" },
    };

    beforeEach(() => {
        vi.resetAllMocks();
    });

    it("extracts classes from relationships and fetches descriptions", async () => {
        (getJsonByCid as any).mockImplementation(async (cid: string) => {
            if (cid === "cid-group") {
                return {
                    relationships: {
                        properties: {
                            company_has_property: {},
                            school_to_fact_sheet: {},
                            tax_to_file: {}, // tax not in manifest; should be skipped
                        },
                    },
                };
            }
            if (cid === "cid-property") {
                return { name: "Property", description: "Property description" };
            }
            if (cid === "cid-company") {
                return { title: "Company" };
            }
            if (cid === "cid-file") {
                return { description: "File desc" };
            }
            if (cid === "cid-school") {
                return {};
            }
            return {};
        });

        const classes = await listClassesFromDataGroup(manifest, "cid-group");
        expect(classes.map((c) => c.key).sort()).toEqual(
            ["company", "file", "property", "school"].sort(),
        );
        const byKey = Object.fromEntries(classes.map((c) => [c.key, c]));
        expect(byKey.property.name).toBe("Property");
        expect(byKey.property.description).toBe("Property description");
        expect(byKey.company.name).toBe("Company");
        expect(byKey.company.description).toBe(null);
        expect(byKey.file.name).toBe("file");
        expect(byKey.file.description).toBe("File desc");
        expect(byKey.school.name).toBe("school");
    });

    it("supports nested JSON Schema path for relationships (properties.relationships.properties)", async () => {
        (getJsonByCid as any).mockImplementation(async (cid: string) => {
            if (cid === "cid-seed-group") {
                return {
                    properties: {
                        relationships: {
                            properties: {
                                address_has_parcel: {},
                            },
                        },
                    },
                };
            }
            if (cid === "cid-address") return { title: "Address" };
            if (cid === "cid-parcel") return { title: "Parcel" };
            return {};
        });

        const manifestWithAddressParcel: Manifest = {
            address: { ipfsCid: "cid-address", type: "class" },
            parcel: { ipfsCid: "cid-parcel", type: "class" },
        };

        const classes = await listClassesFromDataGroup(
            manifestWithAddressParcel,
            "cid-seed-group",
        );
        expect(classes.map((c) => c.key).sort()).toEqual(
            ["address", "parcel"].sort(),
        );
    });
});

describe("fetchManifest", () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
        vi.restoreAllMocks();
    });
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it("fetches and parses manifest", async () => {
        globalThis.fetch = vi.fn(async () =>
            new Response(
                JSON.stringify({
                    Seed: { ipfsCid: "cid1", type: "dataGroup" },
                    property: { ipfsCid: "cid2", type: "class" },
                }),
                { status: 200 },
            ),
        ) as any;

        const manifest = await fetchManifest();
        expect(manifest.Seed.ipfsCid).toBe("cid1");
    });
});


