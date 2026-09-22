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
): Promise<{ index: AtlasIndexV1; indexCid: string }> {
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
    index: AtlasIndexV1Schema.parse(parseJson(bytes, "Atlas index")),
    indexCid,
  };
}

async function verifiedDagJson(
  cid: string,
  options: AtlasGatewayFetchOptions,
): Promise<unknown> {
  const bytes = (await fetchRawAtlasBlock(cid, options)).value;
  await verifyRawBlockCid(bytes, cid);
  try {
    return decodeDagJson(bytes);
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
): Promise<CountyIndexV1> {
  return CountyIndexV1Schema.parse(await verifiedDagJson(cid, options));
}

export async function fetchCountyTables(
  cid: string,
  expectedCountyRoot: string,
  options: AtlasGatewayFetchOptions = {},
): Promise<CountyTablesV1> {
  return parseCountyTablesV1(
    await verifiedDagJson(cid, options),
    expectedCountyRoot,
  );
}

export async function downloadAtlasPart(
  cid: string,
  expectedBytes: number,
  directory: string,
  options: AtlasGatewayFetchOptions = {},
): Promise<{ bytes: number; filePath: string }> {
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
      const bytes = await verifyUnixFsCid(writeAndVerify(), cid, expectedBytes);
      await handle.sync();
      await handle.close();
      await rename(temporaryPath, finalPath);
      return bytes;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
  return { bytes: fetched.value, filePath: finalPath };
}
