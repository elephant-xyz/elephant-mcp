import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it } from "vitest";

import {
  calculateAtlasIndexCid,
  CidVerificationError,
  type UnixFsVerifier,
  verifyRawBlockCid,
  verifyUnixFsCid,
} from "./integrity.ts";

const encoder = new TextEncoder();

async function rawCid(bytes: Uint8Array): Promise<string> {
  return CID.createV1(raw.code, await sha256.digest(bytes)).toString();
}

async function* chunks(...values: Uint8Array[]) {
  yield* values;
}

const rawLeafVerifier: UnixFsVerifier = {
  async calculateCid(source) {
    const parts: Uint8Array[] = [];
    for await (const part of source) {
      parts.push(part);
    }
    return rawCid(Buffer.concat(parts));
  },
};

describe("Atlas CID integrity", () => {
  it("verifies exact raw block bytes without decoding or reserializing", async () => {
    const bytes = encoder.encode('{"label":"CountyIndex","version":1}');
    const digest = await sha256.digest(bytes);
    const expectedCid = CID.createV1(0x0129, digest).toString();

    await expect(verifyRawBlockCid(bytes, expectedCid)).resolves.toEqual({
      actualCid: expectedCid,
      bytes: bytes.byteLength,
      expectedCid,
    });
  });

  it("reports the calculated CID when raw block bytes are changed", async () => {
    const bytes = encoder.encode("trusted bytes");
    const expectedCid = CID.createV1(
      0x0129,
      await sha256.digest(bytes),
    ).toString();
    const tampered = encoder.encode("tampered bytes");
    const actualCid = CID.createV1(
      0x0129,
      await sha256.digest(tampered),
    ).toString();

    try {
      await verifyRawBlockCid(tampered, expectedCid);
      expect.fail("expected CID verification to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CidVerificationError);
      expect(error).toMatchObject({ actualCid, expectedCid });
    }
  });

  it("calculates the Atlas index byte CID as a CIDv1 raw leaf", async () => {
    const bytes = encoder.encode('{"version":1,"counties":[]}');
    const expectedCid = await rawCid(bytes);

    await expect(calculateAtlasIndexCid(bytes)).resolves.toBe(expectedCid);
  });

  it("verifies a streamed UnixFS CID and declared byte count", async () => {
    const first = encoder.encode("streamed ");
    const second = encoder.encode("parquet");
    const expectedCid = await rawCid(Buffer.concat([first, second]));

    await expect(
      verifyUnixFsCid(
        chunks(first, second),
        expectedCid,
        rawLeafVerifier,
        first.byteLength + second.byteLength,
      ),
    ).resolves.toEqual({
      actualCid: expectedCid,
      bytes: first.byteLength + second.byteLength,
      expectedCid,
    });
  });

  it("rejects UnixFS CID and byte-count mismatches", async () => {
    const bytes = encoder.encode("part bytes");
    const expectedCid = await rawCid(bytes);
    const wrongCid = await rawCid(encoder.encode("other bytes"));
    const wrongVerifier: UnixFsVerifier = {
      async calculateCid(source) {
        for await (const chunk of source) {
          // Consume the entire stream as a production verifier must.
          void chunk;
        }
        return wrongCid;
      },
    };

    await expect(
      verifyUnixFsCid(chunks(bytes), expectedCid, wrongVerifier),
    ).rejects.toBeInstanceOf(CidVerificationError);
    await expect(
      verifyUnixFsCid(
        chunks(bytes),
        expectedCid,
        rawLeafVerifier,
        bytes.byteLength + 1,
      ),
    ).rejects.toThrow(`UnixFS byte count is ${bytes.byteLength}`);
  });
});
