import { describe, expect, it } from "vitest";

import {
  extractIpnsName,
  filebaseCidUrl,
  parseCountyCidFallbackMap,
} from "./cidFallback.ts";

const CID = "QmP7WZiZhY1NyCCzzinNX3SCgobA8WqDmZ94xkzkLEaLUS";

describe("county CID fallbacks", () => {
  it("strictly validates and normalizes county CID entries", () => {
    expect(
      parseCountyCidFallbackMap(
        JSON.stringify({ " Broward ": CID }),
        "TEST_CID_MAP",
      ),
    ).toEqual({ broward: CID });
    expect(() =>
      parseCountyCidFallbackMap(
        JSON.stringify({ broward: "not-a-cid" }),
        "TEST_CID_MAP",
      ),
    ).toThrow("valid CIDv0");
  });

  it("extracts path and subdomain IPNS names without accepting direct CIDs", () => {
    const ipns =
      "k51qzi5uqu5dibuhwyztmkjgvz94v3mkpgfreryxwb3d4neta5e7tsxebfi09s";
    expect(extractIpnsName(`https://ipfs.filebase.io/ipns/${ipns}`)).toBe(ipns);
    expect(extractIpnsName(`https://${ipns}.ipns.dweb.link/`)).toBe(ipns);
    expect(extractIpnsName(filebaseCidUrl(CID))).toBeNull();
  });
});
