import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it } from "vitest";

import {
  AtlasGatewayFetchError,
  fetchAtlasIndex,
  fetchAtlasUnixFs,
  fetchRawAtlasBlock,
} from "./gateways.ts";

async function cid(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return CID.createV1(raw.code, await sha256.digest(bytes)).toString();
}

describe("Atlas gateway fetching", () => {
  it("tries gateways in order and returns the first successful response", async () => {
    const seen: { headers: Headers; url: string }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push({ headers: new Headers(init?.headers), url });
      if (url.startsWith("https://first.test/")) {
        return new Response("unavailable", {
          status: 503,
          statusText: "Unavailable",
        });
      }
      return new Response("index bytes");
    };

    const result = await fetchAtlasIndex("k51atlas", {
      gateways: ["https://first.test/", "https://second.test"],
      fetcher,
    });

    expect(result.gateway).toBe("https://second.test");
    expect(result.url).toBe("https://second.test/ipns/k51atlas?format=raw");
    expect(await result.response.text()).toBe("index bytes");
    expect(seen.map(({ url }) => url)).toEqual([
      "https://first.test/ipns/k51atlas?format=raw",
      "https://second.test/ipns/k51atlas?format=raw",
    ]);
    expect(seen[0].headers.get("accept")).toBe("application/vnd.ipld.raw");
    expect(seen[0].headers.get("cache-control")).toBe("no-cache");
  });

  it("builds raw-block and UnixFS URLs without changing gateway order", async () => {
    const expectedCid = await cid("part");
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response("ok");
    };
    const options = {
      gateways: ["https://gateway.test"],
      fetcher,
    };

    await fetchRawAtlasBlock(expectedCid, options);
    await fetchAtlasUnixFs(expectedCid, options);

    expect(seen).toEqual([
      `https://gateway.test/ipfs/${expectedCid}?format=raw`,
      `https://gateway.test/ipfs/${expectedCid}`,
    ]);
  });

  it("reports every HTTP and network failure", async () => {
    const expectedCid = await cid("missing");
    const fetcher: typeof fetch = async (input) => {
      if (String(input).startsWith("https://first.test/")) {
        return new Response("bad gateway", {
          status: 502,
          statusText: "Bad Gateway",
        });
      }
      throw new Error("connection refused");
    };

    try {
      await fetchRawAtlasBlock(expectedCid, {
        gateways: ["https://first.test", "https://second.test"],
        fetcher,
      });
      expect.fail("expected all gateways to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AtlasGatewayFetchError);
      const aggregate = error as AtlasGatewayFetchError;
      expect(aggregate.attempts).toHaveLength(2);
      expect(aggregate.message).toContain(
        `https://first.test/ipfs/${expectedCid}?format=raw: HTTP 502 Bad Gateway`,
      );
      expect(aggregate.message).toContain(
        `https://second.test/ipfs/${expectedCid}?format=raw: connection refused`,
      );
    }
  });

  it("times out a stalled gateway request", async () => {
    const fetcher: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error("missing timeout signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });

    try {
      await fetchAtlasIndex("k51atlas", {
        gateways: ["https://slow.test"],
        fetcher,
        timeoutMs: 5,
      });
      expect.fail("expected the gateway to time out");
    } catch (error) {
      expect(error).toBeInstanceOf(AtlasGatewayFetchError);
      const aggregate = error as AtlasGatewayFetchError;
      expect(aggregate.attempts[0].reason).toBe("timeout after 5ms");
    }
  });
});
