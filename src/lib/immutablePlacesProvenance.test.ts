import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCatalogPlacesTableProvenance } from "./immutablePlacesProvenance.ts";

const IPNS_NAME =
  "k51qzi5uqu5djfa3kbhcxedqlh7kiuyi22bd60he1nsa0wr2jrseo6vvxvwke5";
const ROOT_CID = "bafybeicfvfm5reer2ugipirxufpu6u3tmseoezsdfyhseysoo6p5r2mj4a";
const DIRECTORY_CID =
  "bafybeiamme7bzagrsfmqmvglnq3tzum5n76xfkbns54zu2oc3gmukffmze";
const LEAF_CID = "QmU8DpFQVWgKESeLqKPk8uFGcn8tmLWThXixib2wazBdV5";
const TABLE_URL = `https://ipfs.filebase.io/ipns/${IPNS_NAME}/lee/places-table.parquet`;
const IPNS_PATH = `/ipns/${IPNS_NAME}/lee/places-table.parquet`;

function response(
  roots: string | null,
  options: {
    readonly path?: string | null;
    readonly status?: number;
  } = {},
): Response {
  const headers = new Headers();
  if (roots !== null) headers.set("X-IPFS-ROOTS", roots);
  if (options.path !== null) {
    headers.set("x-IpFs-PaTh", options.path ?? IPNS_PATH);
  }
  return new Response(null, {
    status: options.status ?? 200,
    headers,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("immutable places-table provenance", () => {
  it("uses the first root as IPNS root and complete-path last root as leaf", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response(`${ROOT_CID}, ${DIRECTORY_CID}, ${LEAF_CID}`),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveCatalogPlacesTableProvenance(TABLE_URL);

    expect(result).toMatchObject({
      status: "resolved",
      publishable: true,
      ipnsName: IPNS_NAME,
      relativePath: "lee/places-table.parquet",
      rootCid: ROOT_CID,
      contentCid: LEAF_CID,
      immutableTableUrl: `https://ipfs.filebase.io/ipfs/${ROOT_CID}/lee/places-table.parquet`,
      immutableContentUrl: `https://ipfs.filebase.io/ipfs/${LEAF_CID}`,
      reason: null,
    });
    expect(result.identityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ method: "HEAD", redirect: "manual" });
    }
  });

  it("keeps root provenance but omits a leaf when the header is incomplete", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(ROOT_CID)));

    const result = await resolveCatalogPlacesTableProvenance(TABLE_URL);

    expect(result.status).toBe("resolved");
    expect(result.rootCid).toBe(ROOT_CID);
    expect(result.contentCid).toBeNull();
    expect(result.immutableContentUrl).toBeNull();
  });

  it.each([
    ["missing roots", response(null)],
    ["malformed CID", response("not-a-cid")],
    ["empty root member", response(`${ROOT_CID},,${LEAF_CID}`)],
    [
      "wrong path",
      response(`${ROOT_CID},${DIRECTORY_CID},${LEAF_CID}`, {
        path: `/ipns/${IPNS_NAME}/other/places-table.parquet`,
      }),
    ],
    ["redirect", response(null, { status: 302 })],
  ])("fails closed for %s", async (_label, gatewayResponse) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(gatewayResponse));

    const result = await resolveCatalogPlacesTableProvenance(TABLE_URL);

    expect(result.status).toBe("unavailable");
    expect(result.publishable).toBe(false);
    expect(result.immutableTableUrl).toBeNull();
    expect(result.immutableContentUrl).toBeNull();
  });

  it("rejects untrusted hosts and traversal before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const [untrusted, traversing] = await Promise.all([
      resolveCatalogPlacesTableProvenance(
        `https://example.com/ipns/${IPNS_NAME}/lee/places-table.parquet`,
      ),
      resolveCatalogPlacesTableProvenance(
        `https://ipfs.filebase.io/ipns/${IPNS_NAME}/lee/%2e%2e/places-table.parquet`,
      ),
    ]);

    expect(untrusted.status).toBe("unavailable");
    expect(traversing.status).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("canonicalizes safe path encoding in the immutable URL", async () => {
    const encodedPath = `/ipns/${IPNS_NAME}/Lee%20County/places-table.parquet`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(`${ROOT_CID},${DIRECTORY_CID},${LEAF_CID}`, {
          path: encodedPath,
        }),
      ),
    );

    const result = await resolveCatalogPlacesTableProvenance(
      `https://ipfs.filebase.io${encodedPath}`,
    );

    expect(result.status).toBe("resolved");
    expect(result.relativePath).toBe("Lee County/places-table.parquet");
    expect(result.immutableTableUrl).toBe(
      `https://ipfs.filebase.io/ipfs/${ROOT_CID}/Lee%20County/places-table.parquet`,
    );
  });

  it("fails closed when trusted gateways disagree on the root", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        response(
          `${url.includes("dweb.link") ? ROOT_CID : DIRECTORY_CID},${DIRECTORY_CID},${LEAF_CID}`,
        ),
      ),
    );

    const result = await resolveCatalogPlacesTableProvenance(TABLE_URL);

    expect(result.status).toBe("inconsistent");
    expect(result.publishable).toBe(false);
  });

  it("changes audit identity when the IPNS root changes and is deterministic otherwise", async () => {
    let root = ROOT_CID;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(`${root},${DIRECTORY_CID},${LEAF_CID}`)),
    );

    const first = await resolveCatalogPlacesTableProvenance(TABLE_URL);
    const repeat = await resolveCatalogPlacesTableProvenance(TABLE_URL);
    root = DIRECTORY_CID;
    const changed = await resolveCatalogPlacesTableProvenance(TABLE_URL);

    expect(repeat).toEqual(first);
    expect(changed.rootCid).toBe(DIRECTORY_CID);
    expect(changed.identityDigest).not.toBe(first.identityDigest);
    expect(changed.immutableTableUrl).not.toBe(first.immutableTableUrl);
  });

  it("honors caller abort and the bounded timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            if (init?.signal?.aborted) {
              reject(new DOMException("aborted", "AbortError"));
              return;
            }
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
    );
    const controller = new AbortController();
    controller.abort();

    const [aborted, timedOut] = await Promise.all([
      resolveCatalogPlacesTableProvenance(TABLE_URL, {
        abortSignal: controller.signal,
      }),
      resolveCatalogPlacesTableProvenance(TABLE_URL, { timeoutMs: 1 }),
    ]);

    expect(aborted.status).toBe("unavailable");
    expect(aborted.reason).toMatch(/aborted|timed out/);
    expect(timedOut.status).toBe("unavailable");
    expect(timedOut.reason).toMatch(/aborted|timed out/);
  });
});
