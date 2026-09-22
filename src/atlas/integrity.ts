import Hash from "ipfs-only-hash";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

import { CidV1Schema } from "./contracts.ts";

function mismatch(expectedCid: string, actualCid: string): Error {
  return new Error(
    `CID verification failed: expected ${expectedCid}, calculated ${actualCid}`,
  );
}

/**
 * Verify exact encoded IPLD block bytes against their CID. The producer
 * hashes with sha256 only; the bytes are never parsed or reserialized.
 */
export async function verifyRawBlockCid(
  bytes: Uint8Array,
  expectedCid: string,
): Promise<void> {
  const expected = CID.parse(CidV1Schema.parse(expectedCid));
  if (expected.multihash.code !== sha256.code) {
    throw new Error(
      `Unsupported Atlas multihash code 0x${expected.multihash.code.toString(16)}`,
    );
  }
  const actual = CID.create(
    expected.version,
    expected.code,
    await sha256.digest(bytes),
  );
  if (!actual.equals(expected)) {
    throw mismatch(expected.toString(), actual.toString());
  }
}

/**
 * Calculate the CID used for Atlas index bytes while the index fits in one
 * raw UnixFS leaf (`add --cid-version=1 --raw-leaves=true`).
 */
export async function calculateAtlasIndexCid(
  bytes: Uint8Array,
): Promise<string> {
  return CID.createV1(raw.code, await sha256.digest(bytes)).toString();
}

/**
 * Compare the CID computed from the index bytes with the root a gateway
 * reports in `X-Ipfs-Roots`. Only a single raw leaf can be verified from its
 * bytes; a dag-pb root means the index outgrew one chunk.
 */
export function verifyAtlasIndexRoot(root: string, indexCid: string): void {
  let cid: CID;
  try {
    cid = CID.parse(root);
  } catch {
    throw new Error(`Atlas gateway reported an unparsable index root ${root}`);
  }
  if (cid.code === 0x70) {
    throw new Error(
      `Atlas index root ${root} is a dag-pb node: the index outgrew one raw UnixFS chunk and its bytes can no longer be verified as one leaf`,
    );
  }
  if (cid.code !== raw.code) {
    throw new Error(`Atlas index root ${root} is not a raw leaf`);
  }
  if (cid.toString() !== indexCid) {
    throw mismatch(cid.toString(), indexCid);
  }
}

/**
 * Verify a streamed UnixFS file against the CID produced by
 * `elephant-cli upload` and Kubo's `add --cid-version=1 --raw-leaves=true`
 * and return its byte count, checked against the declared part size.
 */
export async function verifyUnixFsCid(
  source: AsyncIterable<Uint8Array>,
  expectedCid: string,
  expectedBytes?: number,
): Promise<number> {
  const canonicalExpectedCid = CidV1Schema.parse(expectedCid);
  let bytes = 0;
  async function* counted(): AsyncIterable<Uint8Array> {
    for await (const chunk of source) {
      bytes += chunk.byteLength;
      yield chunk;
    }
  }

  const actualCid = CidV1Schema.parse(
    await Hash.of(counted(), { cidVersion: 1, rawLeaves: true }),
  );
  if (actualCid !== canonicalExpectedCid) {
    throw mismatch(canonicalExpectedCid, actualCid);
  }
  if (expectedBytes !== undefined && bytes !== expectedBytes) {
    throw new Error(
      `UnixFS byte count is ${bytes}, expected ${expectedBytes} for ${canonicalExpectedCid}`,
    );
  }
  return bytes;
}
