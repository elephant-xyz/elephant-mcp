import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it } from "vitest";

import {
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
    expect(new TextDecoder().decode(result.value.bytes)).toBe("index bytes");
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
    await fetchAtlasUnixFs(expectedCid, options, async (body) => {
      for await (const chunk of body) void chunk;
    });

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

    await expect(
      fetchRawAtlasBlock(expectedCid, {
        gateways: ["https://first.test", "https://second.test"],
        fetcher,
      }),
    ).rejects.toThrow(
      `Atlas gateway fetch failed for /ipfs/${expectedCid}?format=raw: ` +
        `https://first.test/ipfs/${expectedCid}?format=raw: HTTP 502 Bad Gateway; ` +
        `https://second.test/ipfs/${expectedCid}?format=raw: connection refused`,
    );
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

    await expect(
      fetchAtlasIndex("k51atlas", {
        gateways: ["https://slow.test"],
        fetcher,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(
      "https://slow.test/ipns/k51atlas?format=raw: timeout after 5ms",
    );
  });

  it("falls back to the next gateway when a body stream breaks or stalls", async () => {
    const expectedCid = await cid("part");
    const broken = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          controller.error(new Error("stream reset"));
        },
      });
    // Like fetch, the stalled body errors when the request signal aborts.
    const stalled = (signal: AbortSignal | null | undefined) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first chunk"));
          signal?.addEventListener("abort", () =>
            controller.error(signal.reason),
          );
        },
      });
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://broken.test/")) return new Response(broken());
      if (url.startsWith("https://stalled.test/")) {
        return new Response(stalled(init?.signal));
      }
      return new Response("complete");
    };

    const result = await fetchAtlasUnixFs(
      expectedCid,
      {
        gateways: [
          "https://broken.test",
          "https://stalled.test",
          "https://good.test",
        ],
        fetcher,
        timeoutMs: 20,
      },
      async (body) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of body) chunks.push(chunk);
        return new TextDecoder().decode(Buffer.concat(chunks));
      },
    );
    expect(result).toMatchObject({
      gateway: "https://good.test",
      value: "complete",
    });

    await expect(
      fetchAtlasUnixFs(
        expectedCid,
        {
          gateways: ["https://broken.test", "https://stalled.test"],
          fetcher,
          timeoutMs: 20,
        },
        async (body) => {
          for await (const chunk of body) void chunk;
        },
      ),
    ).rejects.toThrow(/stream reset.*timeout after 20ms/su);
  });

  it("retries the next gateway when the consumer rejects the body", async () => {
    const expectedCid = await cid("part");
    const fetcher: typeof fetch = async (input) =>
      new Response(String(input).includes("bad.test") ? "tampered" : "genuine");

    const result = await fetchAtlasUnixFs(
      expectedCid,
      { gateways: ["https://bad.test", "https://good.test"], fetcher },
      async (body) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of body) chunks.push(chunk);
        const text = new TextDecoder().decode(Buffer.concat(chunks));
        if (text !== "genuine") throw new Error(`CID mismatch for ${text}`);
        return text;
      },
    );
    expect(result.gateway).toBe("https://good.test");
  });
});
