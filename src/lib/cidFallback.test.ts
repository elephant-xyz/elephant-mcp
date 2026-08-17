import { describe, expect, it } from "vitest";

import {
  extractIpnsName,
  filebaseCidUrl,
  parseCountyCidFallbackMap,
} from "./cidFallback.ts";

const INDEX_CID = "QmP7WZiZhY1NyCCzzinNX3SCgobA8WqDmZ94xkzkLEaLUS";

describe("county CID fallbacks", () => {
  it("strictly validates and normalizes county CID entries", () => {
    expect(
      parseCountyCidFallbackMap(
        JSON.stringify({ " Rock Island ": INDEX_CID }),
        "TEST_CID_MAP",
      ),
    ).toEqual({ "rock-island": INDEX_CID });
    expect(() =>
      parseCountyCidFallbackMap(
        JSON.stringify({ "rock-island": "not-a-cid" }),
        "TEST_CID_MAP",
      ),
    ).toThrow("valid CIDv0");
  });

  it("extracts path and subdomain IPNS names without accepting direct CIDs", () => {
    const ipns =
      "k51qzi5uqu5dkmvvxp9idpc5x0x1pd1sv901htkwk30j496kik3c9619n2qmp1";
    expect(extractIpnsName(`https://ipfs.filebase.io/ipns/${ipns}`)).toBe(ipns);
    expect(extractIpnsName(`https://${ipns}.ipns.dweb.link/`)).toBe(ipns);
    expect(extractIpnsName(filebaseCidUrl(INDEX_CID))).toBeNull();
  });
});
