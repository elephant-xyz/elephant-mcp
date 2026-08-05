import { describe, expect, it } from "vitest";

import {
  isAuthorizedHttpRequest,
  resolveHttpAuthorization,
} from "./http-auth.ts";

describe("HTTP bearer authentication", () => {
  it("preserves unauthenticated local HTTP usage when no token is configured", () => {
    expect(isAuthorizedHttpRequest(undefined, undefined)).toBe(true);
  });

  it("accepts the configured bearer token", () => {
    expect(
      isAuthorizedHttpRequest("Bearer watchog-secret", "watchog-secret"),
    ).toBe(true);
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
  });
});
