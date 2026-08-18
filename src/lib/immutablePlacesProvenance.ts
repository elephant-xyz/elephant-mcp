import { createHash } from "node:crypto";

import { CID } from "multiformats/cid";

import { logger } from "../logger.ts";

const FILEBASE_GATEWAY_HOST = "ipfs.filebase.io";
const DWEB_IPNS_SUFFIX = ".ipns.dweb.link";
const RESOLUTION_TIMEOUT_MS = 10_000;
const MAX_HEADER_LENGTH = 8_192;

export const IMMUTABLE_PLACES_RESOLUTION_VERSION =
  "ipfs-gateway-head-x-ipfs-roots-v1";
export const IMMUTABLE_PLACES_IDENTITY_ENCODING =
  "sha256(utf8(rootCid\\ncontentCid-or-null\\nrelativePath\\nimmutableTableUrl\\nimmutableContentUrl-or-null))";

export interface ImmutablePlacesTableProvenance {
  readonly status: "resolved" | "unavailable" | "inconsistent";
  readonly publishable: boolean;
  readonly resolutionMethod: typeof IMMUTABLE_PLACES_RESOLUTION_VERSION;
  readonly ipnsName: string | null;
  readonly relativePath: string | null;
  readonly rootCid: string | null;
  readonly contentCid: string | null;
  readonly immutableTableUrl: string | null;
  readonly immutableContentUrl: string | null;
  readonly identityDigest: string | null;
  readonly identityDigestEncoding: typeof IMMUTABLE_PLACES_IDENTITY_ENCODING;
  readonly reason: string | null;
}

interface ParsedIpnsPlacesUrl {
  readonly ipnsName: string;
  readonly relativeSegments: readonly string[];
  readonly relativePath: string;
  readonly expectedIpnsPath: string;
  readonly endpoints: readonly string[];
  readonly immutableGatewayOrigin: string;
}

interface ValidResolution {
  readonly rootCid: string;
  readonly contentCid: string | null;
}

function isTestLoopback(url: URL): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost")
  );
}

function isTrustedIpnsGateway(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return (
    isTestLoopback(url) ||
    (url.protocol === "https:" &&
      (hostname === FILEBASE_GATEWAY_HOST ||
        hostname.endsWith(DWEB_IPNS_SUFFIX)))
  );
}

function decodeSafeSegment(rawSegment: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    throw new Error(`${label} contains invalid percent encoding.`);
  }
  if (
    decoded === "" ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(decoded)
  ) {
    throw new Error(`${label} contains an unsafe path segment.`);
  }
  return decoded;
}

function parseCatalogIpnsPlacesUrl(raw: string): ParsedIpnsPlacesUrl {
  if (/(?:^|\/)(?:\.{1,2})(?:\/|$)/.test(raw) || /%2e|%2f|%5c/i.test(raw)) {
    throw new Error("Catalog placesTableUrl contains path traversal encoding.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Catalog placesTableUrl is not an absolute URL.");
  }
  if (
    !isTrustedIpnsGateway(url) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && !isTestLoopback(url)) ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "Catalog placesTableUrl is not a trusted IPNS gateway URL.",
    );
  }

  const rawSegments = url.pathname.split("/").slice(1);
  if (rawSegments.some((segment) => segment === "")) {
    throw new Error("Catalog placesTableUrl contains an empty path segment.");
  }

  let ipnsName: string;
  let relativeRawSegments: readonly string[];
  if (
    url.hostname.toLowerCase() === FILEBASE_GATEWAY_HOST ||
    isTestLoopback(url)
  ) {
    if (rawSegments[0]?.toLowerCase() !== "ipns" || rawSegments.length < 3) {
      throw new Error(
        "Catalog placesTableUrl must use /ipns/<name>/<relative-path>.",
      );
    }
    ipnsName = decodeSafeSegment(rawSegments[1] ?? "", "IPNS name");
    relativeRawSegments = rawSegments.slice(2);
  } else {
    ipnsName = url.hostname.slice(0, -DWEB_IPNS_SUFFIX.length);
    relativeRawSegments = rawSegments;
  }

  if (
    ipnsName.length > 255 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(ipnsName)
  ) {
    throw new Error("Catalog placesTableUrl contains an invalid IPNS name.");
  }
  const relativeSegments = relativeRawSegments.map((segment) =>
    decodeSafeSegment(segment, "Relative IPNS path"),
  );
  if (relativeSegments.at(-1) !== "places-table.parquet") {
    throw new Error("Catalog placesTableUrl must end in places-table.parquet.");
  }

  const encodedRelativePath = relativeSegments
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const encodedIpnsName = encodeURIComponent(ipnsName);
  const expectedIpnsPath = `/ipns/${encodedIpnsName}/${encodedRelativePath}`;
  const endpoints = isTestLoopback(url)
    ? [url.toString()]
    : [
        `https://${encodedIpnsName}.ipns.dweb.link/${encodedRelativePath}`,
        `https://${FILEBASE_GATEWAY_HOST}${expectedIpnsPath}`,
      ];
  return {
    ipnsName,
    relativeSegments,
    relativePath: relativeSegments.join("/"),
    expectedIpnsPath,
    endpoints,
    immutableGatewayOrigin: isTestLoopback(url)
      ? url.origin
      : `https://${FILEBASE_GATEWAY_HOST}`,
  };
}

function canonicalCid(raw: string): string | null {
  try {
    const cid = CID.parse(raw);
    return cid.toString();
  } catch {
    return null;
  }
}

function normalizedGatewayPath(raw: string): string | null {
  if (raw.length > MAX_HEADER_LENGTH) {
    return null;
  }
  try {
    const url = new URL(raw, "https://gateway.invalid");
    if (url.origin !== "https://gateway.invalid") {
      return null;
    }
    return url.pathname;
  } catch {
    return null;
  }
}

async function probeEndpoint(
  endpoint: string,
  parsed: ParsedIpnsPlacesUrl,
  signal: AbortSignal,
): Promise<ValidResolution | null> {
  try {
    const response = await fetch(endpoint, {
      method: "HEAD",
      redirect: "manual",
      signal,
    });
    if (!response.ok) {
      return null;
    }
    const finalUrl = new URL(response.url || endpoint);
    if (!isTrustedIpnsGateway(finalUrl)) {
      return null;
    }

    const headerPath = response.headers.get("x-ipfs-path");
    if (
      headerPath !== null &&
      normalizedGatewayPath(headerPath) !== parsed.expectedIpnsPath
    ) {
      return null;
    }
    const rootsHeader = response.headers.get("x-ipfs-roots");
    if (
      rootsHeader === null ||
      rootsHeader.length === 0 ||
      rootsHeader.length > MAX_HEADER_LENGTH
    ) {
      return null;
    }
    const rawRoots = rootsHeader.split(",").map((value) => value.trim());
    if (
      rawRoots.some((value) => value === "") ||
      rawRoots.length > parsed.relativeSegments.length + 1
    ) {
      return null;
    }
    const roots = rawRoots.map(canonicalCid);
    if (roots.some((cid) => cid === null)) {
      return null;
    }
    const rootCid = roots[0];
    if (rootCid === null || rootCid === undefined) {
      return null;
    }

    // Per the IPFS Path Gateway specification, X-Ipfs-Roots is ordered from
    // the mutable IPNS root through each logical path segment. The last CID is
    // therefore the requested leaf only when every expected segment is present.
    const completePath =
      headerPath !== null &&
      rawRoots.length === parsed.relativeSegments.length + 1;
    const lastCid = roots.at(-1) ?? null;
    return {
      rootCid,
      contentCid:
        completePath && lastCid !== rootCid ? (lastCid ?? null) : null,
    };
  } catch (error) {
    if (!signal.aborted) {
      logger.warn(
        {
          gatewayHost: new URL(endpoint).hostname,
          error: error instanceof Error ? error.message : String(error),
        },
        "Immutable places-table HEAD probe failed",
      );
    }
    return null;
  }
}

function unavailable(
  status: "unavailable" | "inconsistent",
  parsed: ParsedIpnsPlacesUrl | null,
  reason: string,
): ImmutablePlacesTableProvenance {
  return {
    status,
    publishable: false,
    resolutionMethod: IMMUTABLE_PLACES_RESOLUTION_VERSION,
    ipnsName: parsed?.ipnsName ?? null,
    relativePath: parsed?.relativePath ?? null,
    rootCid: null,
    contentCid: null,
    immutableTableUrl: null,
    immutableContentUrl: null,
    identityDigest: null,
    identityDigestEncoding: IMMUTABLE_PLACES_IDENTITY_ENCODING,
    reason,
  };
}

/**
 * Resolve the catalog-authorized mutable IPNS table path to an immutable root
 * path. This function is internal provenance infrastructure; MCP callers never
 * supply a URL.
 */
export async function resolveCatalogPlacesTableProvenance(
  catalogPlacesTableUrl: string,
  options: {
    readonly abortSignal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {},
): Promise<ImmutablePlacesTableProvenance> {
  let parsed: ParsedIpnsPlacesUrl;
  try {
    parsed = parseCatalogIpnsPlacesUrl(catalogPlacesTableUrl);
  } catch (error) {
    return unavailable(
      "unavailable",
      null,
      error instanceof Error ? error.message : String(error),
    );
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(
    1,
    Math.min(options.timeoutMs ?? RESOLUTION_TIMEOUT_MS, RESOLUTION_TIMEOUT_MS),
  );
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  options.abortSignal?.addEventListener("abort", abort, { once: true });
  if (options.abortSignal?.aborted) {
    controller.abort();
  }
  try {
    const resolutions = (
      await Promise.all(
        parsed.endpoints.map((endpoint) =>
          probeEndpoint(endpoint, parsed, controller.signal),
        ),
      )
    ).filter(
      (resolution): resolution is ValidResolution => resolution !== null,
    );
    if (resolutions.length === 0) {
      return unavailable(
        "unavailable",
        parsed,
        controller.signal.aborted
          ? "Immutable places-table resolution was aborted or timed out."
          : "Trusted gateways did not return valid IPFS path provenance headers.",
      );
    }
    const rootCids = new Set(resolutions.map(({ rootCid }) => rootCid));
    const contentCids = new Set(
      resolutions
        .map(({ contentCid }) => contentCid)
        .filter((cid): cid is string => cid !== null),
    );
    if (rootCids.size !== 1 || contentCids.size > 1) {
      return unavailable(
        "inconsistent",
        parsed,
        "Trusted gateways returned inconsistent immutable places-table identities.",
      );
    }

    const rootCid = resolutions[0]?.rootCid;
    if (rootCid === undefined) {
      return unavailable(
        "unavailable",
        parsed,
        "Trusted gateways did not return an immutable IPFS root.",
      );
    }
    const contentCid = [...contentCids][0] ?? null;
    const encodedRelativePath = parsed.relativeSegments
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const immutableTableUrl = `${parsed.immutableGatewayOrigin}/ipfs/${rootCid}/${encodedRelativePath}`;
    const immutableContentUrl =
      contentCid === null
        ? null
        : `${parsed.immutableGatewayOrigin}/ipfs/${contentCid}`;
    const identityDigest = createHash("sha256")
      .update(
        [
          rootCid,
          contentCid ?? "null",
          parsed.relativePath,
          immutableTableUrl,
          immutableContentUrl ?? "null",
        ].join("\n"),
        "utf8",
      )
      .digest("hex");
    return {
      status: "resolved",
      publishable: true,
      resolutionMethod: IMMUTABLE_PLACES_RESOLUTION_VERSION,
      ipnsName: parsed.ipnsName,
      relativePath: parsed.relativePath,
      rootCid,
      contentCid,
      immutableTableUrl,
      immutableContentUrl,
      identityDigest,
      identityDigestEncoding: IMMUTABLE_PLACES_IDENTITY_ENCODING,
      reason: null,
    };
  } finally {
    clearTimeout(timeout);
    options.abortSignal?.removeEventListener("abort", abort);
  }
}
