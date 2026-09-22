import { describe, expect, it } from "vitest";

import { registerAllTools } from "./registry.ts";

describe("MCP 2.0 tool registry", () => {
  it("registers only the Atlas, lexicon, and verified-script surface", () => {
    const names: string[] = [];
    registerAllTools({
      registerTool(name: string) {
        names.push(name);
      },
    } as never);

    expect(names.sort()).toEqual(
      [
        "getOracleDatasetInfo",
        "getOracleProperty",
        "getPropertyQuerySchema",
        "getPropertySchema",
        "getVerifiedScriptExamples",
        "listClassesByDataGroup",
        "listOracleProperties",
        "listPropertiesByClassName",
        "listPublishedCounties",
        "queryProperties",
      ].sort(),
    );
  });

  it("does not expose retired data tools", () => {
    const names: string[] = [];
    registerAllTools({
      registerTool(name: string) {
        names.push(name);
      },
    } as never);

    expect(names).not.toEqual(
      expect.arrayContaining([
        "queryHoas",
        "queryPermits",
        "getPropertyPermits",
        "executeDatasetQueryPlan",
        "queryPlaces",
        "analyzePlaceColocation",
      ]),
    );
  });
});
