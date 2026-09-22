/**
 * Loads a real `elephant-cli` archive plus its `export-tables` output through
 * the fake gateway used by the synthetic integration test. Skipped unless
 * ATLAS_REAL_EXPORT_DIR points at a directory holding `county.car`,
 * `export.json`, and `tables/` (see LOCAL_TESTING.md).
 */
import { CarReader } from "@ipld/car";
import * as dagJson from "@ipld/dag-json";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseAtlasDatabaseUrl } from "./backend.ts";
import { openAtlasConnections } from "./connections.ts";
import {
  getAtlasProperty,
  getAtlasQuerySchema,
  listAtlasCounties,
  listAtlasProperties,
  runAtlasQuery,
} from "./query.ts";
import { setAtlasRuntimeForTests } from "./runtime.ts";
import { syncAtlas } from "./sync.ts";
import { keyColumn, readAtlasCatalog } from "./tables.ts";
import { findPropertiesInAreaHandler } from "../tools/atlasGeo.ts";

const exportDir = process.env.ATLAS_REAL_EXPORT_DIR;
const scope = { state: "FL", county: "duval", dataGroup: "county" };
const directories: string[] = [];

afterEach(async () => {
  setAtlasRuntimeForTests();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function carBlocks(file: string, bodies: Map<string, Uint8Array>) {
  const reader = await CarReader.fromBytes(
    new Uint8Array(await readFile(file)),
  );
  for await (const block of reader.blocks()) {
    bodies.set(`/ipfs/${block.cid}?format=raw`, block.bytes);
  }
  return String((await reader.getRoots())[0]);
}

function block<T>(bodies: Map<string, Uint8Array>, cid: string): T {
  const bytes = bodies.get(`/ipfs/${cid}?format=raw`);
  if (bytes === undefined) throw new Error(`missing block ${cid}`);
  return dagJson.decode(bytes) as T;
}

describe.runIf(exportDir !== undefined)("real export-tables output", () => {
  it("loads an elephant-cli archive and serves every tool from it", async () => {
    const dir = exportDir as string;
    const manifest = JSON.parse(
      await readFile(path.join(dir, "export.json"), "utf8"),
    ) as { tables: Record<string, { rows: number; parts: number }> };
    const bodies = new Map<string, Uint8Array>();
    const archiveCid = await carBlocks(path.join(dir, "county.car"), bodies);
    const tablesCid = await carBlocks(
      path.join(dir, "tables", "tables.car"),
      bodies,
    );

    const countyTables = block<{
      tables: Record<string, { parts: Array<{ cid: unknown }> }>;
    }>(bodies, tablesCid);
    for (const [name, table] of Object.entries(countyTables.tables)) {
      for (const [index, part] of table.parts.entries()) {
        bodies.set(
          `/ipfs/${String(part.cid)}`,
          new Uint8Array(
            await readFile(
              path.join(
                dir,
                "tables",
                name,
                `part-${String(index).padStart(5, "0")}.parquet`,
              ),
            ),
          ),
        );
      }
    }

    // The County schema is the data-group whose root is not the property
    // itself (the Seed group's root is the property CID).
    const countyIndex = block<{ shards: unknown[] }>(bodies, archiveCid);
    const shard = block<{
      properties: Array<{
        property_cid: unknown;
        data_groups: Record<string, unknown>;
      }>;
    }>(bodies, String(countyIndex.shards[0]));
    const propertyCid = String(shard.properties[0]?.property_cid);
    const schemaCid = Object.entries(
      shard.properties[0]?.data_groups ?? {},
    ).find(([, root]) => String(root) !== propertyCid)?.[0];
    expect(schemaCid).toBeDefined();

    bodies.set(
      "/ipns/k51-test?format=raw",
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          generated_from: "b43e8d4adb33d43798e610efe404afc79db14642",
          counties: [
            {
              county: scope.county,
              state: scope.state,
              fips: "12031",
              groups: {
                [scope.dataGroup]: {
                  cid: archiveCid,
                  schema: schemaCid,
                  tables: tablesCid,
                  published_at: "2026-09-22T00:00:00.000Z",
                },
              },
            },
          ],
        }),
      ),
    );
    const fetcher = async (input: string | URL | Request) => {
      const url =
        input instanceof Request ? new URL(input.url) : new URL(String(input));
      const body = bodies.get(`${url.pathname}${url.search}`);
      return body === undefined
        ? new Response("missing", { status: 404 })
        : new Response(body, { status: 200 });
    };

    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-real-"));
    directories.push(directory);
    const databaseUrl = `file://${path.join(directory, "atlas.sqlite")}`;
    const summary = await syncAtlas({
      databaseUrl,
      fetch: { fetcher, timeoutMs: 10_000 },
      gateways: ["https://gateway.example"],
      ipns: "k51-test",
      stagingDirectory: path.join(directory, "staging"),
    });
    const tableNames = Object.keys(manifest.tables);
    const totalRows = Object.values(manifest.tables).reduce(
      (sum, table) => sum + table.rows,
      0,
    );
    expect(summary).toMatchObject({ groupsLoaded: 1, unchanged: false });
    expect(summary.loaded[0]).toMatchObject({
      tables: tableNames.length,
      rows: totalRows,
    });

    const backend = parseAtlasDatabaseUrl(databaseUrl);
    const connections = await openAtlasConnections(backend);
    try {
      setAtlasRuntimeForTests({ backend, connections, status: "ready" });
      const catalog = await readAtlasCatalog(connections.read, "sqlite");
      process.stdout.write(
        `\nATLAS CATALOG\n${[...catalog]
          .map(
            ([table, columns]) =>
              `${table} [${keyColumn(columns.map((c) => c.name))}]: ${columns
                .map((column) => `${column.name}:${column.type}`)
                .join(", ")}`,
          )
          .join("\n")}\n\n`,
      );

      expect(await listAtlasCounties()).toMatchObject({
        countyCount: 1,
        indexCid: summary.indexCid,
        counties: [{ county: "duval", state: "FL", fips: "12031" }],
      });

      const schema = await getAtlasQuerySchema(scope);
      expect(schema.tables?.map((table) => table.tableName).sort()).toEqual(
        [...tableNames].sort(),
      );
      for (const table of schema.tables ?? []) {
        expect(table.rows, table.tableName).toBe(
          manifest.tables[table.tableName]?.rows,
        );
      }

      const listed = await listAtlasProperties({
        ...scope,
        limit: 10,
        offset: 0,
      });
      expect(listed.total).toBe(1);
      expect(listed.properties[0]?.property_cid).toBe(propertyCid);

      const property = await getAtlasProperty({ ...scope, propertyCid });
      expect(Object.keys(property.records).sort()).toEqual(
        tableNames.filter((name) => manifest.tables[name]!.rows > 0).sort(),
      );
      const reached = new Set<string>();
      const stored = new Set<string>();
      for (const [table, columns] of catalog) {
        if (keyColumn(columns.map((c) => c.name)) !== "cid") continue;
        for (const row of property.records[table] ?? []) {
          reached.add(String(row.cid));
        }
        for (const row of await connections.read(
          `SELECT cid FROM "${table}"`,
        )) {
          stored.add(String(row.cid));
        }
      }
      expect(reached).toEqual(stored);

      const parcel = await runAtlasQuery({
        ...scope,
        limit: 10,
        sql: "SELECT parcel_identifier FROM parcel",
      });
      expect(parcel.rows[0]?.parcel_identifier).toEqual(expect.any(String));
      const joined = await runAtlasQuery({
        ...scope,
        limit: 10,
        sql: `SELECT p.cid, a.request_identifier
              FROM property p
              JOIN property_has_address r ON r.from_cid = p.cid
              JOIN address a ON a.cid = r.to_cid`,
      });
      expect(joined.rowCount).toBeGreaterThan(0);

      const geo = {
        ...scope,
        bbox: { minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 },
        table: "geometry",
        latitudeColumn: "latitude",
        longitudeColumn: "longitude",
        parcelColumn: "request_identifier",
        valueColumn: "latitude",
      };
      const found = JSON.parse(
        (await findPropertiesInAreaHandler(geo)).content[0]!.text,
      );
      expect(found).toMatchObject({ count: 1, truncated: false });
      const defaults = JSON.parse(
        (
          await findPropertiesInAreaHandler({
            ...geo,
            parcelColumn: "parcel_identifier",
            valueColumn: "avm_value",
          })
        ).content[0]!.text,
      );
      expect(defaults.details).toContain(
        "available columns: state, county, data_group, latitude, longitude",
      );
    } finally {
      await connections.close();
    }
  }, 60_000);
});
