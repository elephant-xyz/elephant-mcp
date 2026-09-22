declare module "ipfs-only-hash" {
  interface HashOptions {
    cidVersion?: number;
    onlyHash?: boolean;
    rawLeaves?: boolean;
  }

  const Hash: {
    of(
      content: Buffer | Uint8Array | string | AsyncIterable<Uint8Array>,
      options?: HashOptions,
    ): Promise<string>;
  };

  export default Hash;
}
