import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { identity } from "multiformats/hashes/identity";
import { sha256, sha512 } from "multiformats/hashes/sha2";

import { CidV1Schema } from "./contracts.ts";

export interface CidVerificationResult {
  actualCid: string;
  bytes: number;
  expectedCid: string;
}

export class CidVerificationError extends Error {
  readonly actualCid: string;
  readonly expectedCid: string;

  constructor(expectedCid: string, actualCid: string) {
    super(
      `CID verification failed: expected ${expectedCid}, calculated ${actualCid}`,
    );
    this.name = "CidVerificationError";
    this.expectedCid = expectedCid;
    this.actualCid = actualCid;
  }
}

async function cidForBlockBytes(
  bytes: Uint8Array,
  expected: CID,
): Promise<CID> {
  switch (expected.multihash.code) {
    case sha256.code:
      return CID.create(
        expected.version,
        expected.code,
        await sha256.digest(bytes),
      );
    case sha512.code:
      return CID.create(
        expected.version,
        expected.code,
        await sha512.digest(bytes),
      );
    case identity.code:
      return CID.create(
        expected.version,
        expected.code,
        await identity.digest(bytes),
      );
    default:
      throw new Error(
        `Unsupported Atlas multihash code 0x${expected.multihash.code.toString(16)}`,
      );
  }
}

/**
 * Verify exact encoded IPLD block bytes against their CID.
 *
 * The bytes are hashed directly with the CID's multihash algorithm. They are
 * never parsed or reserialized, which would change the trust boundary.
 */
export async function verifyRawBlockCid(
  bytes: Uint8Array,
  expectedCid: string,
): Promise<CidVerificationResult> {
  const canonicalExpectedCid = CidV1Schema.parse(expectedCid);
  const expected = CID.parse(canonicalExpectedCid);
  const actual = await cidForBlockBytes(bytes, expected);
  const actualCid = actual.toString();

  if (!actual.equals(expected)) {
    throw new CidVerificationError(canonicalExpectedCid, actualCid);
  }

  return {
    actualCid,
    bytes: bytes.byteLength,
    expectedCid: canonicalExpectedCid,
  };
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
    throw new CidVerificationError(cid.toString(), indexCid);
  }
}

export type ByteSource = AsyncIterable<Uint8Array>;

/**
 * Production implementations must consume the source once and calculate the
 * UnixFS root with CIDv1, raw leaves, and the Kubo-compatible default chunker.
 */
export interface UnixFsVerifier {
  calculateCid(source: ByteSource): Promise<string>;
}

/**
 * Verify a streamed UnixFS file without coupling this package to an importer.
 *
 * The byte count is observed while the injected verifier consumes the source,
 * so callers can also enforce the `CountyTables` part size.
 */
export async function verifyUnixFsCid(
  source: ByteSource,
  expectedCid: string,
  verifier: UnixFsVerifier,
  expectedBytes?: number,
): Promise<CidVerificationResult> {
  const canonicalExpectedCid = CidV1Schema.parse(expectedCid);
  if (
    expectedBytes !== undefined &&
    (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)
  ) {
    throw new Error(
      `Expected UnixFS byte count must be a non-negative safe integer, got ${expectedBytes}`,
    );
  }

  let bytes = 0;
  async function* counted(): ByteSource {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) {
        throw new Error("UnixFS source yielded a non-Uint8Array chunk");
      }
      const nextBytes = bytes + chunk.byteLength;
      if (!Number.isSafeInteger(nextBytes)) {
        throw new Error("UnixFS byte count exceeds the safe integer range");
      }
      bytes = nextBytes;
      yield chunk;
    }
  }

  const actualCid = CidV1Schema.parse(await verifier.calculateCid(counted()));
  if (actualCid !== canonicalExpectedCid) {
    throw new CidVerificationError(canonicalExpectedCid, actualCid);
  }
  if (expectedBytes !== undefined && bytes !== expectedBytes) {
    throw new Error(
      `UnixFS byte count is ${bytes}, expected ${expectedBytes} for ${canonicalExpectedCid}`,
    );
  }

  return {
    actualCid,
    bytes,
    expectedCid: canonicalExpectedCid,
  };
}
