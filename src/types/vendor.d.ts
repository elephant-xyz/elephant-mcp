declare module "ipfs-only-hash" {
  interface HashOptions {
    cidVersion?: number;
    onlyHash?: boolean;
  }

  const Hash: {
    of(
      content: Buffer | Uint8Array | string,
      options?: HashOptions,
    ): Promise<string>;
  };

  export default Hash;
}
