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
         WHERE r.total > 1e3 AND x.property_cid NOT LIKE 'bafy%'`,
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

  it("rejects the function, literal, and quoting bypasses", () => {
    for (const [sql, message] of [
      [
        "SELECT query_to_xml('select * from atlas_state', true, false, '') FROM property",
        "names a control table",
      ],
      [
        "SELECT * FROM xmltable('/x' PASSING cid COLUMNS a text) AS t",
        "not allowed",
      ],
      [
        "SELECT * FROM dblink('dbname=atlas', 'select 1') AS t(a int)",
        "not allowed",
      ],
      [
        "SELECT set_config('search_path', 'other', false) FROM property",
        "not allowed",
      ],
      ["SELECT current_setting('search_path') FROM property", "not allowed"],
      ["SELECT pg_sleep(10) FROM property", "must not reference"],
      ['SELECT * FROM U&"atlas\\005Fstate"', "Prefixed"],
      ["SELECT E'\\x41' FROM property", "Prefixed"],
      ["SELECT $$atlas_state$$ FROM property", "Dollar-quoted"],
      ["SELECT 'atlas_state' AS name FROM property", "names a control table"],
    ] as const) {
      expect(validate(sql), sql).toMatchObject({
        ok: false,
        error: expect.stringContaining(message),
      });
    }
  });

  it("lets aliases qualify columns but never stand as relations", () => {
    expect(
      validate("SELECT * FROM property AS documents, documents"),
    ).toMatchObject({ ok: false, error: expect.stringContaining("documents") });
    expect(
      validate("SELECT * FROM property AS documents JOIN documents ON 1 = 1"),
    ).toMatchObject({ ok: false });
    expect(
      validate(
        "SELECT count(*) AS n, p.cid FROM property p GROUP BY p.cid ORDER BY n",
      ),
    ).toMatchObject({ ok: true });
    expect(
      validate(
        "WITH recent AS (SELECT cid FROM property) SELECT * FROM recent",
      ),
    ).toMatchObject({ ok: true, relations: ["property"] });
  });
});
