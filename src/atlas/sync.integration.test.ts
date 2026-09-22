import { encode as encodeDagJson } from "@ipld/dag-json";
import { DuckDBInstance } from "@duckdb/node-api";
import { CID } from "multiformats/cid";
import * as dagJson from "@ipld/dag-json";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseAtlasDatabaseUrl } from "./backend.ts";
import { openAtlasConnections } from "./connections.ts";
import { escapeAtlasLiteral } from "./tables.ts";
import { syncAtlas } from "./sync.ts";
import { KuboUnixFsVerifier } from "./unixfs.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dagJsonBlock(value: unknown) {
  const bytes = encodeDagJson(value);
  return {
    bytes,
    cid: CID.createV1(dagJson.code, await sha256.digest(bytes)),
  };
}

async function rawCid(value: string) {
  return CID.createV1(
    raw.code,
    await sha256.digest(new TextEncoder().encode(value)),
  );
}

async function* fileChunks(bytes: Uint8Array) {
  yield bytes;
}

async function writeParquet(filePath: string, select: string) {
  const duckdb = await DuckDBInstance.create(":memory:");
  const connection = await duckdb.connect();
  await connection.run(
    `COPY (${select}) TO ${escapeAtlasLiteral(
      filePath,
    )} (FORMAT PARQUET, COMPRESSION ZSTD)`,
  );
  connection.closeSync();
  duckdb.closeSync();
  return new Uint8Array(await readFile(filePath));
}

/**
 * Publish one `property` table for lee/county and return the gateway bodies
 * plus the CountyIndex CID the index points at.
 */
async function publish(
  directory: string,
  revision: string,
  select: string,
  bodies: Map<string, Uint8Array>,
) {
  const parquet = await writeParquet(
    path.join(directory, `${revision}.parquet`),
    select,
  );
  const partCid = await new KuboUnixFsVerifier().calculateCid(
    fileChunks(parquet),
  );
  const countyIndex = await dagJsonBlock({
    label: "CountyIndex",
    version: 1,
    properties: 1,
    shards: [await rawCid(revision)],
  });
  const countyTables = await dagJsonBlock({
    label: "CountyTables",
    version: 1,
    county_root: countyIndex.cid,
    part_size_bytes: 1_073_741_824,
    codec: "zstd",
    tables: {
      property: {
        rows: 1,
        parts: [
          { cid: CID.parse(partCid), rows: 1, bytes: parquet.byteLength },
        ],
      },
    },
  });
  bodies.set(
    "/ipns/k51-test?format=raw",
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        generated_from: `${revision.repeat(40)}`.slice(0, 40),
        counties: [
          {
            county: "lee",
            state: "FL",
            fips: "12071",
            groups: {
              county: {
                cid: countyIndex.cid.toString(),
                schema: (await rawCid("county schema")).toString(),
                tables: countyTables.cid.toString(),
                published_at: "2026-09-21T17:23:52.000Z",
              },
            },
          },
        ],
      }),
    ),
  );
  bodies.set(`/ipfs/${countyIndex.cid}?format=raw`, countyIndex.bytes);
  bodies.set(`/ipfs/${countyTables.cid}?format=raw`, countyTables.bytes);
  bodies.set(`/ipfs/${partCid}`, parquet);
  return countyIndex.cid.toString();
}

describe("Atlas SQLite synchronization", () => {
  it("loads a verified CountyTables publication end to end", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-full-sync-"));
    directories.push(directory);
    const bodies = new Map<string, Uint8Array>();
    const archiveCid = await publish(
      directory,
      "a",
      `SELECT
         'entity-cid'::VARCHAR AS cid,
         'property-cid'::VARCHAR AS property_cid,
         'schema-cid'::VARCHAR AS data_group_cid,
         'parcel-1'::VARCHAR AS parcel_identifier,
         125000::BIGINT AS market_value`,
      bodies,
    );
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url =
        input instanceof Request ? new URL(input.url) : new URL(String(input));
      const body = bodies.get(`${url.pathname}${url.search}`);
      return body === undefined
        ? new Response("missing", { status: 404 })
        : new Response(body, { status: 200 });
    });
    const databaseUrl = `file://${path.join(directory, "atlas.sqlite")}`;
    const connections = await openAtlasConnections(
      parseAtlasDatabaseUrl(databaseUrl),
    );
    const sync = (staging: string) =>
      syncAtlas({
        connections,
        databaseUrl,
        fetch: { fetcher, timeoutMs: 5_000 },
        gateways: ["https://gateway.example"],
        ipns: "k51-test",
        stagingDirectory: path.join(directory, staging),
      });

    try {
      expect(await sync("staging")).toMatchObject({
        groupsLoaded: 1,
        groupsSkipped: 0,
        groupsWithdrawn: 0,
      });
      expect(
        await connections.read(
          `SELECT county, data_group, cid, parcel_identifier, market_value
             FROM property`,
        ),
      ).toEqual([
        {
          county: "lee",
          data_group: "county",
          cid: "entity-cid",
          parcel_identifier: "parcel-1",
          market_value: 125000,
        },
      ]);
      expect(
        await connections.read("SELECT county, archive_cid FROM atlas_state"),
      ).toEqual([{ county: "lee", archive_cid: archiveCid }]);

      // A later archive adds a column and re-carries the same CID with it set.
      await publish(
        directory,
        "b",
        `SELECT
           'entity-cid'::VARCHAR AS cid,
           'property-cid'::VARCHAR AS property_cid,
           'schema-cid'::VARCHAR AS data_group_cid,
           'parcel-1'::VARCHAR AS parcel_identifier,
           125000::BIGINT AS market_value,
           true AS historic`,
        bodies,
      );
      expect(await sync("staging-b")).toMatchObject({ groupsLoaded: 1 });
      expect(
        await connections.read("SELECT cid, historic FROM property"),
      ).toEqual([{ cid: "entity-cid", historic: 1 }]);

      bodies.set(
        "/ipns/k51-test?format=raw",
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            generated_from: "c43e8d4adb33d43798e610efe404afc79db14643",
            counties: [],
          }),
        ),
      );
      expect(await sync("staging-withdrawal")).toMatchObject({
        groupsLoaded: 0,
        groupsWithdrawn: 1,
        unchanged: false,
      });
      expect(
        await connections.read("SELECT count(*) AS count FROM atlas_state"),
      ).toEqual([{ count: 0 }]);
      expect(
        await connections.read("SELECT count(*) AS count FROM property"),
      ).toEqual([{ count: 0 }]);
    } finally {
      await connections.close();
    }
  }, 30_000);
});
