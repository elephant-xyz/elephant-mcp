/**
 * Story 3 — AC5: packaging / per-consumer install documentation.
 *
 * Scope fence: the MCP is a per-consumer install (npx), there is no central
 * hosted endpoint. These assertions guard the package identity + install
 * surface and drive documentation of the new geo tools.
 *
 * RED part: the README does not yet document the new geo tools
 * (`findPropertiesInArea` / `sumPropertyValueInArea`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));

const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
  name: string;
  bin?: Record<string, string>;
};
const readme = readFileSync(readmePath, "utf8");

describe("packaging — per-consumer install identity (sanity)", () => {
  it("publishes under the @elephant-xyz/mcp package name", () => {
    expect(pkg.name).toBe("@elephant-xyz/mcp");
  });

  it("exposes an executable bin so it can be launched per-consumer via npx", () => {
    expect(pkg.bin).toBeDefined();
    expect(Object.keys(pkg.bin ?? {})).toContain("mcp");
  });

  it("documents the npx install command (no central hosted endpoint)", () => {
    expect(readme).toContain("npx");
    expect(readme).toContain("@elephant-xyz/mcp");
  });
});

describe("packaging — new geo tools are documented (red)", () => {
  it("README documents the findPropertiesInArea tool", () => {
    expect(readme).toContain("findPropertiesInArea");
  });

  it("README documents the sumPropertyValueInArea tool", () => {
    expect(readme).toContain("sumPropertyValueInArea");
  });
});
