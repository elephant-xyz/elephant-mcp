import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyAtlasGroupTransaction,
  applyAtlasIndexTransaction,
  formatPostgresCopyValue,
} from "./apply.ts";
import { parseAtlasDatabaseUrl } from "./backend.ts";
import {
  openAtlasConnections,
  type AtlasConnections,
  type AtlasExecutor,
} from "./connections.ts";
import type { AtlasStateRow } from "./plan.ts";
import { initializeAtlasSchema } from "./schema.ts";

const directories: string[] = [];
const INDEX = "bafkreici4fnvhn42zqyxb4ltlrocldghfagnbxhzgjkbck546t6cm6mtky";

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function group(dataGroup: string, state = "FL"): AtlasStateRow {
  return {
    county: "lee",
    state,
    fips: "12071",
    dataGroup,
    archiveCid: `${dataGroup}-archive`,
    tablesCid: `${dataGroup}-tables`,
    schemaCid: `${dataGroup}-schema`,
    publishedAt: "2026-09-21T17:23:52.000Z",
  };
}

const columns = [
  { name: "cid", canonicalType: "text" },
  { name: "property_cid", canonicalType: "text" },
  { name: "data_group_cid", canonicalType: "text" },
  { name: "name", canonicalType: "text" },
] as const;

type Row = [string, string, string, string];

function rows(...values: Row[]): Array<Record<string, unknown>> {
  return values.map(([cid, property_cid, data_group_cid, name]) => ({
    cid,
    property_cid,
    data_group_cid,
    name,
  }));
}

function apply(
  connections: AtlasConnections,
  indexCid: string,
  groups: Array<{ dataGroup: string; rows: Array<Record<string, unknown>> }>,
  withdrawals: string[] = [],
) {
  return connections.transaction((executor) =>
    applyAtlasIndexTransaction({
      backend: "sqlite",
      executor,
      generatedFrom: `generated-${indexCid}`,
      groups: groups.map(({ dataGroup, rows }) => ({
        group: group(dataGroup),
        tables: [
          {
            columns: [...columns],
            name: "company",
            rows: rows.length,
            async *read() {
              yield* rows;
            },
          },
        ],
      })),
      indexCid,
      withdrawals: withdrawals.map((dataGroup) => ({
        county: "lee",
        dataGroup,
        state: "FL",
      })),
    }),
  );
}

describe("Atlas index transaction", () => {
  it("scopes shared content per group and withdraws by scope", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-apply-"));
    directories.push(directory);
    const connections = await openAtlasConnections(
      parseAtlasDatabaseUrl(`file://${path.join(directory, "atlas.sqlite")}`),
    );
    try {
      await initializeAtlasSchema(connections.write);
      await apply(connections, INDEX, [
        {
          dataGroup: "county",
          rows: rows(
            ["shared-cid", "property-a", "county-schema", "Shared"],
            ["other-cid", "property-b", "county-schema", "Other"],
          ),
        },
        {
          dataGroup: "hoa",
          rows: rows(["shared-cid", "property-c", "hoa-schema", "Shared"]),
        },
      ]);
      expect(
        await connections.read(
          "SELECT data_group, property_cid FROM company ORDER BY property_cid",
        ),
      ).toEqual([
        { data_group: "county", property_cid: "property-a" },
        { data_group: "county", property_cid: "property-b" },
        { data_group: "hoa", property_cid: "property-c" },
      ]);

      await apply(connections, `${INDEX.slice(0, -1)}c`, [
        {
          dataGroup: "hoa",
          rows: rows(["shared-cid", "property-c", "hoa-schema", "Changed"]),
        },
      ]);
      expect(
        await connections.read(
          "SELECT name FROM company WHERE data_group = 'hoa'",
        ),
      ).toEqual([{ name: "Changed" }]);

      await apply(connections, `${INDEX.slice(0, -1)}a`, [], ["county"]);
      expect(await connections.read("SELECT data_group FROM company")).toEqual([
        { data_group: "hoa" },
      ]);
      expect(
        await connections.read("SELECT data_group FROM atlas_state"),
      ).toEqual([{ data_group: "hoa" }]);

      await apply(connections, `${INDEX.slice(0, -1)}b`, [], ["hoa"]);
      expect(
        await connections.read("SELECT count(*) AS count FROM company"),
      ).toEqual([{ count: 0 }]);

      await expect(
        apply(connections, `${INDEX.slice(0, -1)}d`, [
          { dataGroup: "hoa", rows: [] },
        ]).catch((error: Error) => error.message),
      ).resolves.toBeUndefined();
      await expect(
        connections.transaction((executor) =>
          applyAtlasIndexTransaction({
            backend: "sqlite",
            executor,
            generatedFrom: "short",
            groups: [
              {
                group: group("hoa"),
                tables: [
                  {
                    columns: [...columns],
                    name: "company",
                    rows: 2,
                    async *read() {
                      yield* rows(["c", "p", "s", "n"]);
                    },
                  },
                ],
              },
            ],
            indexCid: `${INDEX.slice(0, -1)}e`,
            withdrawals: [],
          }),
        ),
      ).rejects.toThrow("loaded 1 rows, expected 2");
    } finally {
      await connections.close();
    }
  });

  it("keeps same-named counties in different states apart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-apply-"));
    directories.push(directory);
    const connections = await openAtlasConnections(
      parseAtlasDatabaseUrl(`file://${path.join(directory, "atlas.sqlite")}`),
    );
    const load = (state: string, name: string) => ({
      group: group("county", state),
      tables: [
        {
          columns: [...columns],
          name: "company",
          rows: 1,
          async *read() {
            yield* rows(["shared-cid", "property", "schema", name]);
          },
        },
      ],
    });
    try {
      await initializeAtlasSchema(connections.write);
      await connections.transaction((executor) =>
        applyAtlasIndexTransaction({
          backend: "sqlite",
          executor,
          generatedFrom: "generated",
          groups: [load("FL", "Florida"), load("CA", "California")],
          indexCid: INDEX,
          withdrawals: [],
        }),
      );
      expect(
        await connections.read(
          "SELECT state, name FROM company ORDER BY state",
        ),
      ).toEqual([
        { state: "CA", name: "California" },
        { state: "FL", name: "Florida" },
      ]);

      await connections.transaction((executor) =>
        applyAtlasIndexTransaction({
          backend: "sqlite",
          executor,
          generatedFrom: "generated-b",
          groups: [],
          indexCid: `${INDEX.slice(0, -1)}a`,
          withdrawals: [
            {
              county: "lee",
              dataGroup: "county",
              state: "CA",
            },
          ],
        }),
      );
      expect(await connections.read("SELECT state FROM company")).toEqual([
        { state: "FL" },
      ]);
      expect(await connections.read("SELECT state FROM atlas_state")).toEqual([
        { state: "FL" },
      ]);
    } finally {
      await connections.close();
    }
  });

  it("formats values for Postgres COPY text and streams Postgres groups via copyFrom", async () => {
    expect(formatPostgresCopyValue(null)).toBe("\\N");
    expect(formatPostgresCopyValue(undefined)).toBe("\\N");
    expect(formatPostgresCopyValue(true)).toBe("t");
    expect(formatPostgresCopyValue(false)).toBe("f");
    expect(formatPostgresCopyValue(42n)).toBe("42");
    expect(formatPostgresCopyValue("a\\b\tc\nd\re\0f")).toBe(
      "a\\\\b\\tc\\nd\\ref",
    );

    const statements: string[] = [];
    const copied: Array<{ statement: string; payload: string }> = [];
    const executor: AtlasExecutor = {
      async execute(statement) {
        statements.push(statement);
        return { rows: [] };
      },
      async copyFrom(statement, chunks) {
        let payload = "";
        for await (const chunk of chunks) {
          payload += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        }
        copied.push({ statement, payload });
      },
    };

    await applyAtlasGroupTransaction({
      backend: "postgres",
      executor,
      group: group("county"),
      tables: [
        {
          columns: [...columns],
          name: "company",
          rows: 2,
          async *read() {
            yield {
              cid: "cid-1",
              property_cid: "prop-1",
              data_group_cid: "dg-1",
              name: "Acme\tLLC\nLine2",
            };
            yield {
              cid: "cid-2",
              property_cid: "prop-2",
              data_group_cid: "dg-1",
              name: null,
            };
          },
        },
      ],
    });

    expect(copied).toHaveLength(1);
    expect(copied[0]?.statement).toContain(
      'COPY pg_temp."_atlas_copy_stage" ("state", "county", "data_group", "cid", "property_cid", "data_group_cid", "name") FROM STDIN WITH (FORMAT text)',
    );
    expect(copied[0]?.payload).toBe(
      "FL\tlee\tcounty\tcid-1\tprop-1\tdg-1\tAcme\\tLLC\\nLine2\nFL\tlee\tcounty\tcid-2\tprop-2\tdg-1\t\\N\n",
    );
    expect(
      statements.some((s) =>
        s.includes('INSERT INTO "company" ("state", "county", "data_group"'),
      ),
    ).toBe(true);
    expect(statements.some((s) => s.includes("INSERT INTO atlas_state"))).toBe(
      true,
    );
  });
});
