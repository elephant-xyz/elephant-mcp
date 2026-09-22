import { importByteStream } from "ipfs-unixfs-importer";

import type { ByteSource, UnixFsVerifier } from "./integrity.ts";

const hashOnlyBlockstore = {
  async put<T>(cid: T): Promise<T> {
    return cid;
  },
};

/**
 * Reproduce the CID used by `elephant-cli upload` and Kubo's
 * `add --cid-version=1 --raw-leaves=true` without retaining generated blocks.
 */
export class KuboUnixFsVerifier implements UnixFsVerifier {
  async calculateCid(source: ByteSource): Promise<string> {
    const result = await importByteStream(source, hashOnlyBlockstore, {
      cidVersion: 1,
      rawLeaves: true,
    });
    return result.cid.toString();
  }
}

export function responseByteSource(response: Response): ByteSource {
  if (response.body === null) {
    throw new Error("Atlas gateway response has no body");
  }

  const reader = response.body.getReader();
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const result = await reader.read();
          if (result.done) {
            return { done: true, value: undefined };
          }
          return { done: false, value: result.value };
        },
        async return() {
          await reader.cancel();
          return { done: true, value: undefined };
        },
      };
    },
  };
}
