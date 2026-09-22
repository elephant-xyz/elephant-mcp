import { CidV1Schema } from "./contracts.ts";

export const DEFAULT_ATLAS_GATEWAYS = [
  "https://ipfs.filebase.io",
  "https://ipfs.io",
  "https://dweb.link",
  "https://w3s.link",
] as const;

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

export interface AtlasGatewayFetchResult {
  gateway: string;
  response: Response;
  url: string;
}

export interface AtlasGatewayFetchOptions {
  gateways?: readonly string[];
  fetcher?: typeof globalThis.fetch;
  timeoutMs?: number;
}

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

async function cancel(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function failureReason(
  error: unknown,
  timeout: AbortSignal,
  timeoutMs: number,
): string {
  if (timeout.aborted) {
    return `timeout after ${timeoutMs}ms`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch a path from gateways in order, returning the first successful 2xx
 * response. Each request has its own timeout and every failed attempt is
 * retained in the aggregate error.
 */
export async function fetchFromAtlasGateways(
  path: string,
  init: RequestInit,
  options: AtlasGatewayFetchOptions = {},
): Promise<AtlasGatewayFetchResult> {
  const { gateways, fetcher, timeoutMs } = validateOptions(options);
  const attempts: AtlasGatewayAttempt[] = [];

  for (const gateway of gateways) {
    const url = `${gateway}${path}`;
    const timeout = AbortSignal.timeout(timeoutMs);

    try {
      const response = await fetcher(url, { ...init, signal: timeout });
      if (response.ok) {
        return { gateway, response, url };
      }

      attempts.push({
        url,
        reason: `HTTP ${response.status}${
          response.statusText === "" ? "" : ` ${response.statusText}`
        }`,
        status: response.status,
      });
      await cancel(response);
    } catch (error) {
      attempts.push({
        url,
        reason: failureReason(error, timeout, timeoutMs),
      });
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
 * Resolve the Atlas index bytes through `/ipns/<name>?format=raw`.
 */
export function fetchAtlasIndex(
  name: string,
  options: AtlasGatewayFetchOptions = {},
): Promise<AtlasGatewayFetchResult> {
  return fetchFromAtlasGateways(
    `/ipns/${ipnsName(name)}?format=raw`,
    {
      headers: {
        Accept: "application/vnd.ipld.raw",
        "Cache-Control": "no-cache",
      },
    },
    options,
  );
}

/**
 * Fetch the exact encoded bytes of an IPLD block.
 */
export function fetchRawAtlasBlock(
  cid: string,
  options: AtlasGatewayFetchOptions = {},
): Promise<AtlasGatewayFetchResult> {
  const canonicalCid = CidV1Schema.parse(cid);
  return fetchFromAtlasGateways(
    `/ipfs/${canonicalCid}?format=raw`,
    {
      headers: {
        Accept: "application/vnd.ipld.raw",
      },
    },
    options,
  );
}

/**
 * Stream the UnixFS file represented by a CID.
 */
export function fetchAtlasUnixFs(
  cid: string,
  options: AtlasGatewayFetchOptions = {},
): Promise<AtlasGatewayFetchResult> {
  const canonicalCid = CidV1Schema.parse(cid);
  return fetchFromAtlasGateways(`/ipfs/${canonicalCid}`, {}, options);
}
