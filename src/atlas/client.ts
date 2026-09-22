import { decode as decodeDagJson } from "@ipld/dag-json";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  AtlasIndexV1Schema,
  CountyIndexV1Schema,
  parseCountyTablesV1,
  type AtlasIndexV1,
  type CountyIndexV1,
  type CountyTablesV1,
} from "./contracts.ts";
import {
  fetchAtlasIndex,
  fetchAtlasUnixFs,
  fetchRawAtlasBlock,
  type AtlasGatewayFetchOptions,
} from "./gateways.ts";
import {
  calculateAtlasIndexCid,
  verifyAtlasIndexRoot,
  verifyRawBlockCid,
  verifyUnixFsCid,
} from "./integrity.ts";

export interface ResolvedAtlasIndex {
  bytes: Uint8Array;
  gateway: string;
  index: AtlasIndexV1;
  indexCid: string;
}

export interface VerifiedAtlasBlock<T> {
  bytes: number;
  gateway: string;
  value: T;
}

export interface DownloadedAtlasPart {
  bytes: number;
  filePath: string;
  gateway: string;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function resolveAtlasIndex(
  ipns: string,
  options: AtlasGatewayFetchOptions = {},
): Promise<ResolvedAtlasIndex> {
  const fetched = await fetchAtlasIndex(ipns, options);
  const bytes = fetched.value.bytes;
  const indexCid = await calculateAtlasIndexCid(bytes);
  const root = fetched.value.roots
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (root !== undefined) {
    verifyAtlasIndexRoot(root, indexCid);
  }
  return {
    bytes,
    gateway: fetched.gateway,
    index: AtlasIndexV1Schema.parse(parseJson(bytes, "Atlas index")),
    indexCid,
  };
}

async function verifiedDagJson(
  cid: string,
  options: AtlasGatewayFetchOptions,
): Promise<{ bytes: Uint8Array; gateway: string; value: unknown }> {
  const fetched = await fetchRawAtlasBlock(cid, options);
  const bytes = fetched.value;
  await verifyRawBlockCid(bytes, cid);
  try {
    return {
      bytes,
      gateway: fetched.gateway,
      value: decodeDagJson(bytes),
    };
  } catch (error) {
    throw new Error(
      `Atlas block ${cid} is not DAG-JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function fetchCountyIndex(
  cid: string,
  options: AtlasGatewayFetchOptions = {},
): Promise<VerifiedAtlasBlock<CountyIndexV1>> {
  const block = await verifiedDagJson(cid, options);
  return {
    bytes: block.bytes.byteLength,
    gateway: block.gateway,
    value: CountyIndexV1Schema.parse(block.value),
  };
}

export async function fetchCountyTables(
  cid: string,
  expectedCountyRoot: string,
  options: AtlasGatewayFetchOptions = {},
): Promise<VerifiedAtlasBlock<CountyTablesV1>> {
  const block = await verifiedDagJson(cid, options);
  return {
    bytes: block.bytes.byteLength,
    gateway: block.gateway,
    value: parseCountyTablesV1(block.value, expectedCountyRoot),
  };
}

export async function downloadAtlasPart(
  cid: string,
  expectedBytes: number,
  directory: string,
  options: AtlasGatewayFetchOptions = {},
): Promise<DownloadedAtlasPart> {
  await mkdir(directory, { recursive: true });
  const finalPath = path.join(directory, `${cid}.parquet`);
  const fetched = await fetchAtlasUnixFs(cid, options, async (body) => {
    const temporaryPath = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      async function* writeAndVerify() {
        for await (const chunk of body) {
          await handle.write(chunk);
          yield chunk;
        }
      }
      const verification = await verifyUnixFsCid(
        writeAndVerify(),
        cid,
        expectedBytes,
      );
      await handle.sync();
      await handle.close();
      await rename(temporaryPath, finalPath);
      return verification.bytes;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
  return {
    bytes: fetched.value,
    filePath: finalPath,
    gateway: fetched.gateway,
  };
}
