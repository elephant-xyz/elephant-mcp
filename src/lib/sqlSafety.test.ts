import { describe, expect, it } from "vitest";

import { validateScopedSelect, validateSelectQuery } from "./sqlSafety.ts";

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

describe("scoped SQL validation", () => {
  const relations = new Map([
    ["property", ["cid", "property_cid", "parcel_identifier"]],
    ["properties", ["property_cid"]],
  ]);
  const validate = (sql: string) => validateScopedSelect(sql, relations);

  it("accepts aliases, functions, CTEs, and reports referenced relations", () => {
    expect(
      validate(
        `WITH recent AS (SELECT p.cid, count(*) total FROM property p GROUP BY p.cid)
         SELECT r.cid, lower(x.property_cid) AS owner
         FROM recent AS r JOIN properties x ON x.property_cid = r.cid
         WHERE r.total > 1e3 AND x.property_cid NOT LIKE 'atlas_state%'`,
      ),
    ).toMatchObject({ ok: true, relations: ["property", "properties"] });
  });

  it("rejects control tables, catalogs, schema qualifiers, and unknown names", () => {
    for (const sql of [
      "SELECT * FROM property, atlas_state",
      'SELECT * FROM "atlas_state"',
      "SELECT * FROM `atlas_sync_state`",
      "SELECT * FROM main.property",
      "SELECT * FROM public.property",
      "SELECT * FROM sqlite_master",
      "SELECT * FROM information_schema.tables",
      "SELECT * FROM pragma_table_info('property')",
      "SELECT * FROM (SELECT 1) AS x, unknown_table",
      "SELECT * FROM property JOIN other ON other.cid = property.cid",
    ]) {
      expect(validate(sql), sql).toMatchObject({ ok: false });
    }
  });
});
