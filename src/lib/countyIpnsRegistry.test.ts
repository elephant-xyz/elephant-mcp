import { describe, it, expect } from "vitest";
import {
  normalizeCountyKey,
  parseCountyIpnsMap,
  resolveCountyIpns,
} from "./countyIpnsRegistry.ts";

const LEE_IPNS =
  "k51qzi5uqu5dlzgslzedrnk4whtd7ip69l0pmd3zxelz8hwjorbeyy0pyyeu4m";
const PB_IPNS =
  "k51qzi5uqu5dgjnt84x8vnj2c9uwxomkpykwdvmf6xg43wwcxsifo6w1sp1wwh";

describe("normalizeCountyKey", () => {
  it("lowercases, trims, and hyphenates whitespace", () => {
    expect(normalizeCountyKey("Lee")).toBe("lee");
    expect(normalizeCountyKey("  Palm Beach  ")).toBe("palm-beach");
    expect(normalizeCountyKey("Miami  Dade")).toBe("miami-dade");
  });
});

describe("parseCountyIpnsMap", () => {
  it("returns an empty map when unset or blank", () => {
    expect(parseCountyIpnsMap(undefined)).toEqual({});
    expect(parseCountyIpnsMap("")).toEqual({});
    expect(parseCountyIpnsMap("   ")).toEqual({});
  });

  it("parses and normalizes keys", () => {
    const raw = JSON.stringify({ Lee: LEE_IPNS, "Palm Beach": PB_IPNS });
    expect(parseCountyIpnsMap(raw)).toEqual({
      lee: LEE_IPNS,
      "palm-beach": PB_IPNS,
    });
  });

  it("ignores malformed JSON and non-object shapes", () => {
    expect(parseCountyIpnsMap("not json")).toEqual({});
    expect(parseCountyIpnsMap("[1,2,3]")).toEqual({});
    expect(parseCountyIpnsMap("null")).toEqual({});
  });

  it("skips entries with non-string or blank IPNS values", () => {
    const raw = JSON.stringify({ lee: LEE_IPNS, bad: 42, blank: "  " });
    expect(parseCountyIpnsMap(raw)).toEqual({ lee: LEE_IPNS });
  });
});

describe("resolveCountyIpns — legacy single-IPNS mode (no map)", () => {
  const env = {
    map: undefined,
    singleIpns: LEE_IPNS,
    defaultCounty: undefined,
  };

  it("resolves any county to the single IPNS (post-fetch guard filters)", () => {
    expect(resolveCountyIpns("Lee", env)).toMatchObject({
      ipnsName: LEE_IPNS,
      served: true,
      allowFixedFallback: true,
    });
    expect(resolveCountyIpns("Miami-Dade", env)).toMatchObject({
      ipnsName: LEE_IPNS,
      served: true,
    });
    expect(resolveCountyIpns(undefined, env)).toMatchObject({
      ipnsName: LEE_IPNS,
      served: true,
    });
  });

  it("allows fixed-CID fallback even when no single IPNS is set", () => {
    const bare = {
      map: undefined,
      singleIpns: undefined,
      defaultCounty: undefined,
    };
    expect(resolveCountyIpns(undefined, bare)).toMatchObject({
      ipnsName: null,
      served: true,
      allowFixedFallback: true,
    });
  });
});

describe("resolveCountyIpns — multi-county registry mode", () => {
  const env = {
    map: JSON.stringify({ lee: LEE_IPNS, "palm-beach": PB_IPNS }),
    singleIpns: undefined,
    defaultCounty: "lee",
  };

  it("resolves a registered county to its own IPNS (no fixed fallback)", () => {
    expect(resolveCountyIpns("lee", env)).toMatchObject({
      ipnsName: LEE_IPNS,
      served: true,
      allowFixedFallback: false,
      countyKey: "lee",
    });
    expect(resolveCountyIpns("Palm Beach", env)).toMatchObject({
      ipnsName: PB_IPNS,
      served: true,
      countyKey: "palm-beach",
    });
  });

  it("resolves different counties to different IPNS names", () => {
    const lee = resolveCountyIpns("lee", env).ipnsName;
    const pb = resolveCountyIpns("palm-beach", env).ipnsName;
    expect(lee).not.toBe(pb);
  });

  it("falls back to the default county when no county is requested", () => {
    expect(resolveCountyIpns(undefined, env)).toMatchObject({
      ipnsName: LEE_IPNS,
      served: true,
      countyKey: "lee",
    });
  });

  it("marks an unknown county as not served", () => {
    expect(resolveCountyIpns("nowhere", env)).toMatchObject({
      served: false,
      ipnsName: null,
      countyKey: "nowhere",
    });
  });
});
