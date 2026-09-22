import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));

const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
  name: string;
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
  version: string;
};
const readme = readFileSync(readmePath, "utf8");

describe("packaging — per-consumer install identity (sanity)", () => {
  it("publishes under the @elephant-xyz/mcp package name", () => {
    expect(pkg.name).toBe("@elephant-xyz/mcp");
    expect(pkg.version).toBe("2.0.0");
  });

  it("exposes an executable bin so it can be launched per-consumer via npx", () => {
    expect(pkg.bin).toBeDefined();
    expect(Object.keys(pkg.bin ?? {})).toContain("mcp");
  });

  it("documents the npx install command (no central hosted endpoint)", () => {
    expect(readme).toContain("npx");
    expect(readme).toContain("@elephant-xyz/mcp");
  });

  it("packages and documents the Atlas sync entry point", () => {
    expect(pkg.scripts?.sync).toBe("node dist/index.js sync");
    expect(readme).toContain("ATLAS_IPNS");
    expect(readme).toContain("DATABASE_URL");
    expect(readme).toContain("npm run sync");
  });
});

describe("packaging — retained geo tools", () => {
  it("README documents the findPropertiesInArea tool", () => {
    expect(readme).toContain("findPropertiesInArea");
  });

  it("README documents the sumPropertyValueInArea tool", () => {
    expect(readme).toContain("sumPropertyValueInArea");
  });
});
