import { timingSafeEqual } from "node:crypto";

type HeaderValue = string | string[] | undefined;

function secureEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
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

export function resolveConfiguredHttpAuthTokens(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const tokens = [
    ...parseHttpAuthTokens(env.MCP_HTTP_AUTH_TOKEN),
    ...parseHttpAuthTokens(env.MCP_HTTP_AUTH_TOKENS),
  ];
  return [...new Set(tokens)];
}

export function isAuthorizedHttpRequest(
  authorization: string | undefined,
  expectedTokens: string | readonly string[] | undefined,
): boolean {
  const configuredTokens =
    typeof expectedTokens === "string"
      ? parseHttpAuthTokens(expectedTokens)
      : (expectedTokens ?? []).flatMap((token) => parseHttpAuthTokens(token));

  if (configuredTokens.length === 0) {
    return true;
  }

  if (authorization === undefined) {
    return false;
  }

  let matched = false;
  for (const token of configuredTokens) {
    if (secureEqual(authorization, `Bearer ${token}`)) {
      matched = true;
    }
  }
  return matched;
}
