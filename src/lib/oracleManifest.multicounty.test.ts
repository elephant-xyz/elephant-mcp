import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveManifestCid, getOpenDataIpnsName } from "./oracleManifest.ts";

/**
 * Multi-county open-data resolution: a single deployment resolves each requested
 * county to its own IPNS (and thus its own CID). IPNS→CID resolution is mocked
 * (no live network) by stubbing global fetch to echo a deterministic root CID
 * derived from the IPNS label in the request URL.
 */

const LEE_IPNS =
  "k51qzi5uqu5dlzgslzedrnk4whtd7ip69l0pmd3zxelz8hwjorbeyy0pyyeu4m";
const PB_IPNS =
  "k51qzi5uqu5dgjnt84x8vnj2c9uwxomkpykwdvmf6xg43wwcxsifo6w1sp1wwh";

const ENV_KEYS = [
  "ORACLE_OPEN_DATA_IPNS_MAP",
  "ORACLE_OPEN_DATA_IPNS",
  "ORACLE_OPEN_DATA_DEFAULT_COUNTY",
  "ORACLE_OPEN_DATA_MANIFEST_CID",
] as const;

let saved: Record<string, string | undefined> = {};

/** Extract the IPNS name from the dweb.link subdomain URL the resolver builds. */
function ipnsFromUrl(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  // Stub IPNS resolution: HEAD returns the resolved root CID in x-ipfs-roots.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ipns = ipnsFromUrl(url);
      return {
        ok: true,
        headers: {
          get: (header: string) =>
            header === "x-ipfs-roots" ? `cid-${ipns}` : null,
        },
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

describe("resolveManifestCid — multi-county registry", () => {
  beforeEach(() => {
    process.env.ORACLE_OPEN_DATA_IPNS_MAP = JSON.stringify({
      lee: LEE_IPNS,
      "palm-beach": PB_IPNS,
    });
    process.env.ORACLE_OPEN_DATA_DEFAULT_COUNTY = "lee";
  });

  it("resolves each county to a distinct CID via its own IPNS", async () => {
    const leeCid = await resolveManifestCid("lee");
    const pbCid = await resolveManifestCid("palm-beach");

    expect(leeCid).toBe(`cid-${LEE_IPNS}`);
    expect(pbCid).toBe(`cid-${PB_IPNS}`);
    expect(leeCid).not.toBe(pbCid);
  });

  it("normalizes the county arg (Palm Beach → palm-beach)", async () => {
    expect(await resolveManifestCid("Palm Beach")).toBe(`cid-${PB_IPNS}`);
  });

  it("falls back to the default county when no county is given", async () => {
    expect(await resolveManifestCid()).toBe(`cid-${LEE_IPNS}`);
  });

  it("returns null for an unknown county (not served)", async () => {
    expect(await resolveManifestCid("nowhere")).toBeNull();
  });

  it("reports the resolved IPNS name per county", () => {
    expect(getOpenDataIpnsName("lee")).toBe(LEE_IPNS);
    expect(getOpenDataIpnsName("palm-beach")).toBe(PB_IPNS);
    expect(getOpenDataIpnsName("nowhere")).toBeNull();
  });

  it("default county falls back to the fixed CID when its IPNS fails to resolve", async () => {
    // Regression: lee is the default county and present in the map; if its IPNS
    // resolution yields nothing, the fixed manifest CID must still be served.
    process.env.ORACLE_OPEN_DATA_MANIFEST_CID = "QmFixedDefaultCid";
    // Re-stub fetch so IPNS resolution returns no root CID (resolution fails).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          ok: true,
          headers: { get: () => null },
        } as unknown as Response;
      }),
    );

    expect(await resolveManifestCid("lee")).toBe("QmFixedDefaultCid");
    // A non-default county gets no fixed fallback → null when its IPNS fails.
    expect(await resolveManifestCid("palm-beach")).toBeNull();
  });
});

describe("resolveManifestCid — backward compat (no map)", () => {
  it("uses the single ORACLE_OPEN_DATA_IPNS for any/no county", async () => {
    process.env.ORACLE_OPEN_DATA_IPNS = LEE_IPNS;

    expect(await resolveManifestCid()).toBe(`cid-${LEE_IPNS}`);
    expect(await resolveManifestCid("Lee")).toBe(`cid-${LEE_IPNS}`);
    // Legacy mode resolves regardless of county; the post-fetch guard filters.
    expect(await resolveManifestCid("Miami-Dade")).toBe(`cid-${LEE_IPNS}`);
  });

  it("falls back to the fixed manifest CID when no IPNS is set", async () => {
    process.env.ORACLE_OPEN_DATA_MANIFEST_CID = "QmFixedCid";
    expect(await resolveManifestCid()).toBe("QmFixedCid");
  });
});
