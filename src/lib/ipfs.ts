import { createHelia, type Helia } from "helia";
import { json as createJsonClient } from "@helia/json";
import type { JSON as Json } from "@helia/json";
import { CID } from "multiformats/cid";
import { sha256, sha512 } from "multiformats/hashes/sha2";
import { identity } from "multiformats/hashes/identity";
import { base32 } from "multiformats/bases/base32";
import { equals as u8eq } from "uint8arrays/equals";
import { logger } from "../logger.ts";
import Hash from "ipfs-only-hash";

interface VerificationResult {
  valid: boolean;
  expectedHash: string;
  actualHash: string;
}

let heliaInstance: Helia | null = null;
let jsonClient: Json | null = null;

async function getHelia(): Promise<Helia> {
  if (!heliaInstance) {
    logger.info("Initializing Helia instance");
    heliaInstance = await createHelia();
  }
  return heliaInstance;
}

async function getJsonClient(): Promise<Json> {
  if (!jsonClient) {
    const helia = await getHelia();
    jsonClient = createJsonClient(helia);
  }
  return jsonClient;
}

export async function getJsonByCid<T>(cidString: string): Promise<T> {
  try {
    const jsonString = await fetchFromIpfs(cidString);
    const data = JSON.parse(jsonString);
    return data as T;
  } catch (gatewayError) {
    try {
      const json = await getJsonClient();
      const cid = CID.parse(cidString);
      const data = await json.get(cid);
      return data as T;
    } catch (error) {
      logger.error("Failed to fetch JSON by CID from both Helia and gateways", {
        cid: cidString,
        heliaError: error instanceof Error ? error.message : String(error),
        gatewayError:
          gatewayError instanceof Error
            ? gatewayError.message
            : String(gatewayError),
      });
      throw gatewayError;
    }
  }
}

export async function fetchFromIpfs(cid: string): Promise<string> {
  logger.info(`Fetching ${cid}`);
  const ipfsGateways: string[] = [
    "https://ipfs.io",
    "https://gateway.ipfs.io",
    "https://dweb.link",
    "https://w3s.link",
  ];
  for (const gateway of ipfsGateways) {
    try {
      const response = await fetch(`${gateway}/ipfs/${cid}`);
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const content = new Uint8Array(buffer);
        const responseText = new TextDecoder().decode(content);
        const verificationResult = await verifyFetchedContent(cid, content);
        logger.debug(
          `Verification result: ${JSON.stringify(verificationResult)}`,
        );
        if (!verificationResult.valid) {
          logger.error(`CID ${cid} content does not match expected hash.`);
          logger.error(responseText);
          throw new Error(`CID ${cid} content does not match expected hash.`);
        }
        return responseText;
      }
    } catch (e) {
      logger.error(
        `Failed to fetch from ${gateway}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  throw new Error(`Failed to fetch from any IPFS gateway: ${cid}`);
}

// Codec code for raw bytes (used by lexicon/schema CIDs).
const RAW_CODEC = 0x55;

export async function verifyFetchedContent(
  cidStr: string,
  content: Uint8Array,
): Promise<VerificationResult> {
  const cid = CID.parse(cidStr);

  // For RAW-codec CIDs the gateway serves the raw bytes and the multihash
  // is directly over those bytes — use the fast path.
  if (cid.code === RAW_CODEC) {
    let hasher;
    switch (cid.multihash.code) {
      case sha256.code:
        hasher = sha256;
        break;
      case sha512.code:
        hasher = sha512;
        break;
      case identity.code:
        hasher = identity;
        break;
      default:
        throw new Error(`Unsupported hasher code ${cid.multihash.code}`);
    }

    const mh = await hasher.digest(content);
    return {
      valid: u8eq(mh.bytes, cid.multihash.bytes),
      expectedHash: base32.encode(cid.multihash.bytes),
      actualHash: base32.encode(mh.bytes),
    };
  }

  // For dag-pb / UnixFS CIDs (codec 0x70, all Qm... CIDv0) the gateway
  // serves the raw file bytes, NOT the dag-pb block bytes, so
  // sha256(rawContent) !== cid.multihash.  Recompute the CID from the
  // content using ipfs-only-hash — the same library used to produce these
  // CIDs — and compare structurally.
  const recomputedCidStr = await Hash.of(Buffer.from(content), {
    cidVersion: cid.version,
  });
  const recomputedCid = CID.parse(recomputedCidStr);
  const valid = recomputedCid.equals(cid);

  return {
    valid,
    expectedHash: cidStr,
    actualHash: recomputedCidStr,
  };
}
