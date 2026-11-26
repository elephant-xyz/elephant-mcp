import { describe, expect, it } from "vitest";

import {
  isAuthorizedHttpRequest,
  parseHttpAuthTokens,
  resolveConfiguredHttpAuthTokens,
  resolveHttpAuthorization,
} from "./http-auth.ts";

describe("HTTP bearer authentication", () => {
  it("preserves unauthenticated local HTTP usage when no token is configured", () => {
    expect(isAuthorizedHttpRequest(undefined, undefined)).toBe(true);
    expect(isAuthorizedHttpRequest(undefined, [])).toBe(true);
    expect(isAuthorizedHttpRequest(undefined, " , ")).toBe(true);
  });

  it("accepts the configured bearer token", () => {
    expect(
      isAuthorizedHttpRequest("Bearer watchog-secret", "watchog-secret"),
    ).toBe(true);
  });

  it("accepts any token from a comma-separated list or array", () => {
    const commaList = "primary-secret, enact-secret , third-secret";
    expect(isAuthorizedHttpRequest("Bearer primary-secret", commaList)).toBe(
      true,
    );
    expect(isAuthorizedHttpRequest("Bearer enact-secret", commaList)).toBe(
      true,
    );
    expect(isAuthorizedHttpRequest("Bearer third-secret", commaList)).toBe(
      true,
    );
    expect(isAuthorizedHttpRequest("Bearer wrong-secret", commaList)).toBe(
      false,
    );

    const tokenList = ["primary-secret", "enact-secret"];
    expect(isAuthorizedHttpRequest("Bearer primary-secret", tokenList)).toBe(
      true,
    );
    expect(isAuthorizedHttpRequest("Bearer enact-secret", tokenList)).toBe(
      true,
    );
    expect(isAuthorizedHttpRequest("Bearer wrong-secret", tokenList)).toBe(
      false,
    );
  });

  it("combines MCP_HTTP_AUTH_TOKEN and MCP_HTTP_AUTH_TOKENS without duplicates", () => {
    expect(parseHttpAuthTokens(" token-a, , token-b ")).toEqual([
      "token-a",
      "token-b",
    ]);
    expect(
      resolveConfiguredHttpAuthTokens({
        MCP_HTTP_AUTH_TOKEN: "existing-secret",
        MCP_HTTP_AUTH_TOKENS: "enact-secret, existing-secret, extra-secret",
      }),
    ).toEqual(["existing-secret", "enact-secret", "extra-secret"]);
    expect(resolveConfiguredHttpAuthTokens({})).toEqual([]);
  });

  it("resolves the custom token header when the platform consumes Authorization", () => {
    expect(
      resolveHttpAuthorization({
        authorization: "Bearer platform-token",
        "X-MCP-Auth-Token": "watchog-secret",
      }),
    ).toBe("Bearer watchog-secret");
  });

  it.each([
    undefined,
    "",
    "watchog-secret",
    "Basic watchog-secret",
    "Bearer wrong-secret",
  ])("rejects an invalid authorization header: %s", (authorization) => {
    expect(isAuthorizedHttpRequest(authorization, "watchog-secret")).toBe(
      false,
    );
    expect(
      isAuthorizedHttpRequest(authorization, [
        "watchog-secret",
        "enact-secret",
      ]),
    ).toBe(false);
  });
});
