import { describe, expect, it } from "vitest";

import { validateSelectQuery } from "./sqlSafety.ts";

describe("read-only SQL validation", () => {
  it("accepts one SELECT and trailing semicolon", () => {
    expect(validateSelectQuery("SELECT * FROM properties;")).toEqual({
      ok: true,
      sql: "SELECT * FROM properties",
    });
  });

  it("ignores keywords in literals and comments", () => {
    expect(
      validateSelectQuery("SELECT 'delete' AS value FROM properties -- DROP"),
    ).toMatchObject({ ok: true });
  });

  it("rejects mutations and multiple statements", () => {
    expect(validateSelectQuery("DELETE FROM properties")).toMatchObject({
      ok: false,
    });
    expect(
      validateSelectQuery("SELECT * FROM properties; SELECT * FROM properties"),
    ).toMatchObject({ ok: false });
  });
});
