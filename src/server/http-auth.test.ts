import { describe, expect, it } from "vitest";

import {
  isAuthorizedHttpRequest,
  parseHttpAuthTokens,
  resolveConfiguredHttpAuth,
  resolveHttpAuthorization,
} from "./http-auth.ts";

describe("HTTP bearer authentication", () => {
  it("preserves unauthenticated local HTTP usage only when auth is unset or empty", () => {
    expect(isAuthorizedHttpRequest(undefined, undefined)).toBe(true);
    expect(isAuthorizedHttpRequest(undefined, "")).toBe(true);
    expect(
      isAuthorizedHttpRequest(undefined, resolveConfiguredHttpAuth({})),
    ).toBe(true);
    expect(
      isAuthorizedHttpRequest(
        undefined,
        resolveConfiguredHttpAuth({
          MCP_HTTP_AUTH_TOKEN: "",
          MCP_HTTP_AUTH_TOKENS: "",
        }),
      ),
    ).toBe(true);
  });

  it("fails closed when auth env vars are non-empty but yield zero valid tokens", () => {
    for (const env of [
      { MCP_HTTP_AUTH_TOKEN: "   " },
      { MCP_HTTP_AUTH_TOKENS: "   " },
      { MCP_HTTP_AUTH_TOKENS: "," },
      { MCP_HTTP_AUTH_TOKENS: " , , " },
    ]) {
      const config = resolveConfiguredHttpAuth(env);
      expect(config).toEqual({
        enabled: true,
        tokens: [],
        malformed: true,
      });
      expect(isAuthorizedHttpRequest(undefined, config)).toBe(false);
      expect(isAuthorizedHttpRequest("Bearer anything", config)).toBe(false);
    }

    expect(isAuthorizedHttpRequest(undefined, "   ")).toBe(false);
  });

  it("preserves MCP_HTTP_AUTH_TOKEN as an opaque single token even if it contains commas", () => {
    const config = resolveConfiguredHttpAuth({
      MCP_HTTP_AUTH_TOKEN: "legacy,with,commas",
    });
    expect(config).toEqual({
      enabled: true,
      tokens: ["legacy,with,commas"],
      malformed: false,
    });
    expect(isAuthorizedHttpRequest("Bearer legacy,with,commas", config)).toBe(
      true,
    );
    expect(isAuthorizedHttpRequest("Bearer legacy", config)).toBe(false);
    expect(isAuthorizedHttpRequest("Bearer commas", config)).toBe(false);
  });

  it("accepts the configured bearer token", () => {
    expect(
      isAuthorizedHttpRequest("Bearer watchog-secret", "watchog-secret"),
    ).toBe(true);
  });

  it("accepts comma-separated tokens from MCP_HTTP_AUTH_TOKENS with or without MCP_HTTP_AUTH_TOKEN", () => {
    expect(parseHttpAuthTokens(" token-a, , token-b ")).toEqual([
      "token-a",
      "token-b",
    ]);

    const pluralOnly = resolveConfiguredHttpAuth({
      MCP_HTTP_AUTH_TOKENS: " enact-secret , third-secret ",
    });
    expect(pluralOnly).toEqual({
      enabled: true,
      tokens: ["enact-secret", "third-secret"],
      malformed: false,
    });
    expect(isAuthorizedHttpRequest("Bearer enact-secret", pluralOnly)).toBe(
      true,
    );
    expect(isAuthorizedHttpRequest("Bearer third-secret", pluralOnly)).toBe(
      true,
    );
    expect(isAuthorizedHttpRequest("Bearer wrong-secret", pluralOnly)).toBe(
      false,
    );

    const combined = resolveConfiguredHttpAuth({
      MCP_HTTP_AUTH_TOKEN: "existing-secret",
      MCP_HTTP_AUTH_TOKENS: "enact-secret, existing-secret, extra-secret",
    });
    expect(combined).toEqual({
      enabled: true,
      tokens: ["existing-secret", "enact-secret", "extra-secret"],
      malformed: false,
    });
    expect(isAuthorizedHttpRequest("Bearer existing-secret", combined)).toBe(
      true,
    );
    expect(isAuthorizedHttpRequest("Bearer enact-secret", combined)).toBe(true);
    expect(isAuthorizedHttpRequest("Bearer extra-secret", combined)).toBe(true);
    expect(isAuthorizedHttpRequest("Bearer wrong-secret", combined)).toBe(
      false,
    );
  });

  it("keeps protecting the endpoint with MCP_HTTP_AUTH_TOKEN when MCP_HTTP_AUTH_TOKENS is malformed", () => {
    const config = resolveConfiguredHttpAuth({
      MCP_HTTP_AUTH_TOKEN: "existing-secret",
      MCP_HTTP_AUTH_TOKENS: " , ",
    });
    expect(config).toEqual({
      enabled: true,
      tokens: ["existing-secret"],
      malformed: false,
    });
    expect(isAuthorizedHttpRequest("Bearer existing-secret", config)).toBe(
      true,
    );
    expect(isAuthorizedHttpRequest(undefined, config)).toBe(false);
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
      isAuthorizedHttpRequest(
        authorization,
        resolveConfiguredHttpAuth({
          MCP_HTTP_AUTH_TOKEN: "watchog-secret",
          MCP_HTTP_AUTH_TOKENS: "enact-secret",
        }),
      ),
    ).toBe(false);
  });
});
