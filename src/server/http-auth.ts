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

export function isAuthorizedHttpRequest(
  authorization: string | undefined,
  expectedToken: string | undefined,
): boolean {
  if (expectedToken === undefined || expectedToken === "") {
    return true;
  }

  return (
    authorization !== undefined &&
    secureEqual(authorization, `Bearer ${expectedToken}`)
  );
}
