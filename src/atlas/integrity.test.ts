import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it } from "vitest";

import {
  calculateAtlasIndexCid,
  CidVerificationError,
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
        first.byteLength + second.byteLength,
      ),
    ).resolves.toEqual({
      actualCid: expectedCid,
      bytes: first.byteLength + second.byteLength,
      expectedCid,
    });
  });

  it("hashes multi-chunk streams as a Kubo dag-pb root", async () => {
    const bytes = new Uint8Array(300_000).fill(7);

    await expect(
      verifyUnixFsCid(
        chunks(bytes.subarray(0, 1000), bytes.subarray(1000)),
        await rawCid(bytes),
      ),
    ).rejects.toMatchObject({
      actualCid: expect.stringMatching(/^bafybei/u),
    });
  });

  it("rejects UnixFS CID and byte-count mismatches", async () => {
    const bytes = encoder.encode("part bytes");
    const expectedCid = await rawCid(bytes);

    await expect(
      verifyUnixFsCid(chunks(bytes), await rawCid(encoder.encode("other"))),
    ).rejects.toBeInstanceOf(CidVerificationError);
    await expect(
      verifyUnixFsCid(chunks(bytes), expectedCid, bytes.byteLength + 1),
    ).rejects.toThrow(`UnixFS byte count is ${bytes.byteLength}`);
  });
});
