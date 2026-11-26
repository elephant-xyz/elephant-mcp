import { createHash, timingSafeEqual } from "node:crypto";

type HeaderValue = string | string[] | undefined;

export interface HttpAuthConfig {
  readonly enabled: boolean;
  readonly tokens: readonly string[];
  readonly malformed: boolean;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function secureEqual(actual: string, expected: string): boolean {
  // Compare fixed-length SHA-256 digests so timing does not leak token lengths.
  return timingSafeEqual(sha256(actual), sha256(expected));
}

export function resolveHttpAuthorization(
  headers: Readonly<Record<string, HeaderValue>>,
): string | undefined {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const customToken = normalizedHeaders.get("x-mcp-auth-token");
  const customTokenValue = Array.isArray(customToken)
    ? customToken[0]
    : customToken;
  if (customTokenValue !== undefined && customTokenValue !== "") {
    return `Bearer ${customTokenValue}`;
  }

  const authorization = normalizedHeaders.get("authorization");
  return Array.isArray(authorization) ? authorization[0] : authorization;
}

export function parseHttpAuthTokens(rawTokens: string | undefined): string[] {
  if (rawTokens === undefined) {
    return [];
  }

  return rawTokens
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function resolveConfiguredHttpAuth(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HttpAuthConfig {
  const legacyRaw = env.MCP_HTTP_AUTH_TOKEN;
  const additionalRaw = env.MCP_HTTP_AUTH_TOKENS;
  const legacyConfigured = legacyRaw !== undefined && legacyRaw !== "";
  const additionalConfigured =
    additionalRaw !== undefined && additionalRaw !== "";
  const enabled = legacyConfigured || additionalConfigured;

  const tokens: string[] = [];
  if (legacyConfigured && legacyRaw.trim().length > 0) {
    // Keep MCP_HTTP_AUTH_TOKEN opaque (verbatim, never split on commas)
    // so an existing write-only production token cannot change behavior.
    tokens.push(legacyRaw);
  }
  if (additionalConfigured) {
    tokens.push(...parseHttpAuthTokens(additionalRaw));
  }

  const dedupedTokens = [...new Set(tokens)];
  return {
    enabled,
    tokens: dedupedTokens,
    malformed: enabled && dedupedTokens.length === 0,
  };
}

export function isAuthorizedHttpRequest(
  authorization: string | undefined,
  expected: HttpAuthConfig | string | undefined,
): boolean {
  const config: HttpAuthConfig =
    typeof expected === "string" || expected === undefined
      ? resolveConfiguredHttpAuth({ MCP_HTTP_AUTH_TOKEN: expected })
      : expected;

  if (!config.enabled) {
    return true;
  }

  if (config.tokens.length === 0 || authorization === undefined) {
    return false;
  }

  // Evaluate every configured token without short-circuiting (`||=`) to keep
  // timing independent of which token slot matched.
  let matched = false;
  for (const token of config.tokens) {
    if (secureEqual(authorization, `Bearer ${token}`)) {
      matched = true;
    }
  }
  return matched;
}
