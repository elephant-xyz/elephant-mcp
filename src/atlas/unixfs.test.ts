import { describe, expect, it } from "vitest";

import { verifyUnixFsCid } from "./integrity.ts";
import { KuboUnixFsVerifier } from "./unixfs.ts";

async function* chunks() {
  yield new TextEncoder().encode("verified ");
  yield new TextEncoder().encode("parquet bytes");
}

describe("Kubo-compatible UnixFS verification", () => {
  it("recomputes a streaming CID and byte count", async () => {
    const verifier = new KuboUnixFsVerifier();
    const expectedCid = await verifier.calculateCid(chunks());

    await expect(
      verifyUnixFsCid(chunks(), expectedCid, verifier, 22),
    ).resolves.toEqual({
      actualCid: expectedCid,
      bytes: 22,
      expectedCid,
    });
  });

  it("rejects a different UnixFS CID", async () => {
    const verifier = new KuboUnixFsVerifier();

    await expect(
      verifyUnixFsCid(
        chunks(),
        "bafkreici4fnvhn42zqyxb4ltlrocldghfagnbxhzgjkbck546t6cm6mtky",
        verifier,
      ),
    ).rejects.toThrow("CID verification failed");
  });
});
