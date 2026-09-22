import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it } from "vitest";

import { resolveAtlasIndex } from "./client.ts";

const body = JSON.stringify({
  version: 1,
  generated_from: "b43e8d4adb33d43798e610efe404afc79db14642",
  counties: [],
});

function resolve(roots?: string) {
  return resolveAtlasIndex("k51-test", {
    gateways: ["https://gateway.example"],
    fetcher: async () =>
      new Response(body, {
        status: 200,
        headers: roots === undefined ? {} : { "x-ipfs-roots": roots },
      }),
  });
}

describe("Atlas index root verification", () => {
  it("accepts a matching raw root and an absent header", async () => {
    const digest = await sha256.digest(new TextEncoder().encode(body));
    const rawRoot = CID.createV1(raw.code, digest).toString();

    expect((await resolve()).indexCid).toBe(rawRoot);
    expect((await resolve(`bafyother,${rawRoot}`)).indexCid).toBe(rawRoot);
    await expect(
      resolve(
        CID.createV1(
          raw.code,
          await sha256.digest(new Uint8Array(1)),
        ).toString(),
      ),
    ).rejects.toThrow("CID verification failed");
  });

  it("explains a dag-pb root as an index that outgrew one chunk", async () => {
    const dagPb = CID.createV1(
      0x70,
      await sha256.digest(new TextEncoder().encode(body)),
    ).toString();

    await expect(resolve(dagPb)).rejects.toThrow(
      "outgrew one raw UnixFS chunk",
    );
  });
});
