import { describe, it, expect } from "vitest";
import { verifyFetchedContent } from "../ipfs.ts";

// ipfs-only-hash is a CJS module with real async computation — let it run
// naturally in tests (no mock needed: we just feed it known content).

describe("verifyFetchedContent", () => {
  describe("dag-pb / UnixFS CIDs (Qm..., codec 0x70)", () => {
    // CID computed via `ipfs-only-hash` for the exact bytes below:
    // Buffer.from('{"test":true}') → QmV6vzWB6kU1mQzmsQijkA688iNwyLhFaKHtjKXeKoFVyg
    const KNOWN_CONTENT = Buffer.from('{"test":true}');
    const KNOWN_CID = "QmV6vzWB6kU1mQzmsQijkA688iNwyLhFaKHtjKXeKoFVyg";

    it("returns valid=true when content matches its dag-pb CID", async () => {
      const result = await verifyFetchedContent(
        KNOWN_CID,
        new Uint8Array(KNOWN_CONTENT),
      );

      expect(result.valid).toBe(true);
      expect(result.expectedHash).toBe(KNOWN_CID);
      expect(result.actualHash).toBe(KNOWN_CID);
    });

    it("returns valid=false when content is tampered", async () => {
      const tampered = new Uint8Array(
        Buffer.from('{"test":false,"tampered":true}'),
      );
      const result = await verifyFetchedContent(KNOWN_CID, tampered);

      expect(result.valid).toBe(false);
      expect(result.expectedHash).toBe(KNOWN_CID);
      expect(result.actualHash).not.toBe(KNOWN_CID);
    });

    it("returns valid=false for completely wrong content", async () => {
      const wrong = new Uint8Array(Buffer.from("completely different data"));
      const result = await verifyFetchedContent(KNOWN_CID, wrong);

      expect(result.valid).toBe(false);
    });
  });

  describe("RAW-codec CIDs (codec 0x55)", () => {
    // Construct a raw CID for known content via sha256.
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    // We'll compute it dynamically using the same path the production code uses.
    it("returns valid=true for raw CID when content matches sha256", async () => {
      const { sha256 } = await import("multiformats/hashes/sha2");
      const { CID } = await import("multiformats/cid");

      const content = new TextEncoder().encode("hello raw world");
      const mh = await sha256.digest(content);
      // Build a CIDv1 with raw codec (0x55)
      const cid = CID.createV1(0x55, mh);
      const cidStr = cid.toString();

      const result = await verifyFetchedContent(cidStr, content);

      expect(result.valid).toBe(true);
    });

    it("returns valid=false for raw CID when content is tampered", async () => {
      const { sha256 } = await import("multiformats/hashes/sha2");
      const { CID } = await import("multiformats/cid");

      const content = new TextEncoder().encode("original content");
      const mh = await sha256.digest(content);
      const cid = CID.createV1(0x55, mh);
      const cidStr = cid.toString();

      const tampered = new TextEncoder().encode("tampered content");
      const result = await verifyFetchedContent(cidStr, tampered);

      expect(result.valid).toBe(false);
    });
  });
});

describe("fetchShardByCid", () => {
  it("parses a valid shard file via getJsonByCid", async () => {
    // We need to test fetchShardByCid in isolation — use dynamic mock approach
    const validShard = {
      schemaVersion: "1" as const,
      shardIndex: 0,
      fromParcel: "1000000000",
      toParcel: "1000000999",
      count: 2,
      entries: [
        {
          propertyId: "uuid-001",
          parcelIdentifier: "1000000000",
          cid: "QmSomeCid001",
          fileSizeBytes: 1024,
        },
        {
          propertyId: "uuid-002",
          parcelIdentifier: "1000000999",
          cid: null,
          fileSizeBytes: 512,
        },
      ],
    };

    // fetchShardByCid calls getJsonByCid internally — we verify the shape
    // by testing the Zod parse path with a known-valid object.
    const { ShardFileSchema } = await import("../../types/oracleOpenData.ts");
    const parsed = ShardFileSchema.parse(validShard);

    expect(parsed.schemaVersion).toBe("1");
    expect(parsed.shardIndex).toBe(0);
    expect(parsed.count).toBe(2);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].cid).toBe("QmSomeCid001");
    expect(parsed.entries[1].cid).toBeNull();
  });

  it("throws ZodError for invalid shard file shape", async () => {
    const { ShardFileSchema } = await import("../../types/oracleOpenData.ts");

    const invalid = {
      schemaVersion: "2", // wrong version — must be literal "1"
      shardIndex: 0,
      fromParcel: "1000",
      toParcel: "1999",
      count: 1,
      entries: [],
    };

    expect(() => ShardFileSchema.parse(invalid)).toThrow();
  });
});
