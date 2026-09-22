import { DEFAULT_ATLAS_GATEWAYS } from "../config.ts";
import { CidV1Schema } from "./contracts.ts";

export interface AtlasGatewayAttempt {
  url: string;
  reason: string;
  status?: number;
}

export class AtlasGatewayFetchError extends Error {
  readonly attempts: readonly AtlasGatewayAttempt[];
  readonly path: string;

  constructor(path: string, attempts: readonly AtlasGatewayAttempt[]) {
    const details = attempts
      .map((attempt) => `${attempt.url}: ${attempt.reason}`)
      .join("; ");
    super(`Atlas gateway fetch failed for ${path}: ${details}`);
    this.name = "AtlasGatewayFetchError";
    this.path = path;
    this.attempts = attempts;
  }
}

export interface AtlasGatewayFetchResult<T> {
  gateway: string;
  url: string;
  value: T;
}

export interface AtlasGatewayFetchOptions {
  gateways?: readonly string[];
  fetcher?: typeof globalThis.fetch;
  /** Applies to the response headers and to each gap between body chunks. */
  timeoutMs?: number;
}

type AtlasBodyConsumer<T> = (
  body: AsyncIterable<Uint8Array>,
  response: Response,
) => Promise<T>;

function normalizeGateway(gateway: string): string {
  let url: URL;
  try {
    url = new URL(gateway);
  } catch {
    throw new Error(`Invalid Atlas gateway URL: ${gateway}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Atlas gateway must use HTTP or HTTPS: ${gateway}`);
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `Atlas gateway must be an uncredentialed base URL: ${gateway}`,
    );
  }

  return url.href.replace(/\/+$/u, "");
}

function validateOptions(options: AtlasGatewayFetchOptions): {
  gateways: string[];
  fetcher: typeof globalThis.fetch;
  timeoutMs: number;
} {
  const gateways = (options.gateways ?? DEFAULT_ATLAS_GATEWAYS).map(
    normalizeGateway,
  );
  if (gateways.length === 0) {
    throw new Error("At least one Atlas gateway is required");
  }

  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Atlas gateway timeout must be positive, got ${timeoutMs}`);
  }

  return {
    gateways,
    fetcher: options.fetcher ?? globalThis.fetch,
    timeoutMs,
  };
}

function failureReason(
  error: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): string {
  if (signal.aborted) {
    return `timeout after ${timeoutMs}ms`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Fetch a path from gateways in order and hand the first 2xx body to the
 * consumer. The timeout covers the headers and then re-arms on every body
 * chunk; a stalled or broken stream, or a consumer that rejects (for
 * example on a CID mismatch), moves on to the next gateway. Every failed
 * attempt is retained in the aggregate error.
 */
async function fetchFromAtlasGateways<T>(
  path: string,
  init: RequestInit,
  options: AtlasGatewayFetchOptions,
  consume: AtlasBodyConsumer<T>,
): Promise<AtlasGatewayFetchResult<T>> {
  const { gateways, fetcher, timeoutMs } = validateOptions(options);
  const attempts: AtlasGatewayAttempt[] = [];

  for (const gateway of gateways) {
    const url = `${gateway}${path}`;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), timeoutMs);
    };
    arm();

    try {
      const response = await fetcher(url, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        attempts.push({
          url,
          reason: `HTTP ${response.status}${
            response.statusText === "" ? "" : ` ${response.statusText}`
          }`,
          status: response.status,
        });
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error(`timeout after ${timeoutMs}ms`)),
          { once: true },
        );
      });
      async function* body() {
        if (response.body === null) return;
        const reader = response.body.getReader();
        try {
          for (;;) {
            const next = await Promise.race([reader.read(), aborted]);
            if (next.done) return;
            arm();
            yield next.value;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
      return { gateway, url, value: await consume(body(), response) };
    } catch (error) {
      attempts.push({
        url,
        reason: failureReason(error, controller.signal, timeoutMs),
      });
      controller.abort();
    } finally {
      clearTimeout(timer);
    }
  }

  throw new AtlasGatewayFetchError(path, attempts);
}

function ipnsName(name: string): string {
  if (!/^[A-Za-z0-9.-]+$/u.test(name)) {
    throw new Error(`Invalid IPNS name: ${name}`);
  }
  return encodeURIComponent(name);
}

/**
 * Resolve the Atlas index bytes through `/ipns/<name>?format=raw`, with the
 * root the gateway reports in `X-Ipfs-Roots`.
 */
export function fetchAtlasIndex(
  name: string,
  options: AtlasGatewayFetchOptions = {},
): Promise<
  AtlasGatewayFetchResult<{ bytes: Uint8Array; roots: string | null }>
> {
  return fetchFromAtlasGateways(
    `/ipns/${ipnsName(name)}?format=raw`,
    {
      headers: {
        Accept: "application/vnd.ipld.raw",
        "Cache-Control": "no-cache",
      },
    },
    options,
    async (body, response) => ({
      bytes: await collect(body),
      roots: response.headers.get("x-ipfs-roots"),
    }),
  );
}

/**
 * Fetch the exact encoded bytes of an IPLD block.
 */
export function fetchRawAtlasBlock(
  cid: string,
  options: AtlasGatewayFetchOptions = {},
): Promise<AtlasGatewayFetchResult<Uint8Array>> {
  const canonicalCid = CidV1Schema.parse(cid);
  return fetchFromAtlasGateways(
    `/ipfs/${canonicalCid}?format=raw`,
    { headers: { Accept: "application/vnd.ipld.raw" } },
    options,
    collect,
  );
}

/**
 * Stream the UnixFS file represented by a CID into the consumer.
 */
export function fetchAtlasUnixFs<T>(
  cid: string,
  options: AtlasGatewayFetchOptions,
  consume: AtlasBodyConsumer<T>,
): Promise<AtlasGatewayFetchResult<T>> {
  const canonicalCid = CidV1Schema.parse(cid);
  return fetchFromAtlasGateways(`/ipfs/${canonicalCid}`, {}, options, consume);
}
