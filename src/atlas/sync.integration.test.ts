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
import { escapeAtlasLiteral } from "./registry.ts";
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

describe("Atlas SQLite synchronization", () => {
  it("loads a verified CountyTables publication end to end", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-full-sync-"));
    directories.push(directory);
    const parquetPath = path.join(directory, "property.parquet");
    const duckdb = await DuckDBInstance.create(":memory:");
    const connection = await duckdb.connect();
    await connection.run(
      `COPY (
          SELECT
            'entity-cid'::VARCHAR AS cid,
            'property-cid'::VARCHAR AS property_cid,
            'schema-cid'::VARCHAR AS data_group_cid,
            'parcel-1'::VARCHAR AS parcel_identifier,
            125000::BIGINT AS market_value
        ) TO ${escapeAtlasLiteral(
          parquetPath,
        )} (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
    connection.closeSync();
    duckdb.closeSync();

    const parquet = new Uint8Array(await readFile(parquetPath));
    const partCid = await new KuboUnixFsVerifier().calculateCid(
      fileChunks(parquet),
    );
    const schemaCid = await rawCid("county schema");
    const countyIndex = await dagJsonBlock({
      label: "CountyIndex",
      version: 1,
      properties: 1,
      shards: [],
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
            {
              cid: CID.parse(partCid),
              rows: 1,
              bytes: parquet.byteLength,
            },
          ],
        },
      },
    });
    const indexBytes = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        generated_from: "b43e8d4adb33d43798e610efe404afc79db14642",
        counties: [
          {
            county: "lee",
            state: "FL",
            fips: "12071",
            groups: {
              county: {
                cid: countyIndex.cid.toString(),
                schema: schemaCid.toString(),
                tables: countyTables.cid.toString(),
                published_at: "2026-09-21T17:23:52.000Z",
              },
            },
          },
        ],
      }),
    );
    const bodies = new Map<string, Uint8Array>([
      ["/ipns/k51-test?format=raw", indexBytes],
      [`/ipfs/${countyIndex.cid.toString()}?format=raw`, countyIndex.bytes],
      [`/ipfs/${countyTables.cid.toString()}?format=raw`, countyTables.bytes],
      [`/ipfs/${partCid}`, parquet],
    ]);
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

    try {
      const summary = await syncAtlas({
        connections,
        databaseUrl,
        fetch: { fetcher, timeoutMs: 5_000 },
        gateways: ["https://gateway.example"],
        ipns: "k51-test",
        stagingDirectory: path.join(directory, "staging"),
      });

      expect(summary).toMatchObject({
        groupsLoaded: 1,
        groupsSkipped: 0,
        groupsWithdrawn: 0,
      });
      expect(
        await connections.read(
          `SELECT cid, parcel_identifier, market_value
             FROM atlas_content__property`,
        ),
      ).toEqual([
        {
          cid: "entity-cid",
          parcel_identifier: "parcel-1",
          market_value: 125000,
        },
      ]);
      expect(
        await connections.read(
          `SELECT county, data_group, archive_cid
             FROM atlas_membership`,
        ),
      ).toEqual([
        {
          county: "lee",
          data_group: "county",
          archive_cid: countyIndex.cid.toString(),
        },
      ]);

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
      const withdrawn = await syncAtlas({
        connections,
        databaseUrl,
        fetch: { fetcher, timeoutMs: 5_000 },
        gateways: ["https://gateway.example"],
        ipns: "k51-test",
        stagingDirectory: path.join(directory, "staging-withdrawal"),
      });
      expect(withdrawn).toMatchObject({
        groupsLoaded: 0,
        groupsWithdrawn: 1,
        unchanged: false,
      });
      expect(
        await connections.read(
          "SELECT count(*) AS count FROM atlas_membership",
        ),
      ).toEqual([{ count: 0 }]);
      expect(
        await connections.read(
          "SELECT count(*) AS count FROM atlas_content__property",
        ),
      ).toEqual([{ count: 0 }]);
    } finally {
      await connections.close();
    }
  }, 30_000);
});
