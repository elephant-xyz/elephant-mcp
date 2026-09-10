import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import bundledProfileRegistry from "../data/dataset-query-profiles-v1.json";
import type { PropertyColumn } from "./duckdbQuery.ts";

export const DATASET_QUERY_PROFILE_VERSION =
  "dataset-query-runtime-profile-v1" as const;

const PROFILE_BUILD_CONCURRENCY = 2;
const PROFILE_CACHE_MAX_ENTRIES = 128;
const cidSchema = z
  .string()
  .regex(/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z0-9]+)$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const columnSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
  })
  .strict();
const profileBodySchema = z
  .object({
    profileVersion: z.literal(DATASET_QUERY_PROFILE_VERSION),
    dataset: z.enum(["properties", "permits"]),
    countyKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    sourceCid: cidSchema,
    columns: z.array(columnSchema).min(1),
    rowCount: z.number().int().nonnegative(),
    schemaFingerprint: sha256Schema,
    exact: z.literal(true),
    origin: z.literal("immutable_parquet_metadata"),
  })
  .strict();
const profileSchema = profileBodySchema
  .extend({
    profileIdentity: sha256Schema,
  })
  .strict();
const profileRequestSchema = z
  .object({
    dataset: z.enum(["properties", "permits"]),
    countyKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    sourceCid: cidSchema,
  })
  .strict();
const bundledProfiles = z
  .object({
    schemaVersion: z.literal("1.0"),
    profiles: z.array(profileSchema),
  })
  .strict()
  .parse(bundledProfileRegistry).profiles;

export type DatasetQueryProfile = z.infer<typeof profileSchema>;
export type DatasetQueryProfileDataset = DatasetQueryProfile["dataset"];

export interface DatasetQueryProfileRequest {
  readonly dataset: DatasetQueryProfileDataset;
  readonly countyKey: string;
  readonly sourceCid: string;
}

export interface DatasetQueryProfileBuildResult {
  readonly columns: readonly PropertyColumn[];
  readonly rowCount: number;
}

export interface DatasetQueryProfileOptions {
  readonly cacheDirectory?: string;
  readonly build: (
    signal?: AbortSignal,
  ) => Promise<DatasetQueryProfileBuildResult>;
  readonly signal?: AbortSignal;
}

const memoryProfiles = new Map<string, DatasetQueryProfile>();
const pendingProfiles = new Map<string, Promise<DatasetQueryProfile>>();
const buildWaiters: Array<() => void> = [];
let activeBuilds = 0;

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("cannot canonicalize a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`cannot canonicalize ${typeof value}`);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function profileKey(request: DatasetQueryProfileRequest): string {
  return `${request.dataset}:${request.countyKey}:${request.sourceCid}`;
}

function profilePath(
  request: DatasetQueryProfileRequest,
  cacheDirectory: string,
): string {
  return join(
    cacheDirectory,
    `${request.dataset}-${request.countyKey}-${request.sourceCid}.json`,
  );
}

function validateProfile(
  value: unknown,
  request: DatasetQueryProfileRequest,
): DatasetQueryProfile {
  const profile = profileSchema.parse(value);
  if (
    profile.dataset !== request.dataset ||
    profile.countyKey !== request.countyKey ||
    profile.sourceCid !== request.sourceCid
  ) {
    throw new Error("dataset query profile identity does not match its source");
  }
  const body = profileBodySchema.strip().parse(profile);
  if (sha256(profile.columns) !== profile.schemaFingerprint) {
    throw new Error("dataset query profile schema fingerprint is invalid");
  }
  if (sha256(body) !== profile.profileIdentity) {
    throw new Error("dataset query profile identity is invalid");
  }
  return profile;
}

function createProfile(
  request: DatasetQueryProfileRequest,
  result: DatasetQueryProfileBuildResult,
): DatasetQueryProfile {
  const columns = result.columns.map((column) => ({
    name: column.name,
    type: column.type,
  }));
  const body = profileBodySchema.parse({
    profileVersion: DATASET_QUERY_PROFILE_VERSION,
    dataset: request.dataset,
    countyKey: request.countyKey,
    sourceCid: request.sourceCid,
    columns,
    rowCount: result.rowCount,
    schemaFingerprint: sha256(columns),
    exact: true,
    origin: "immutable_parquet_metadata",
  });
  return profileSchema.parse({
    ...body,
    profileIdentity: sha256(body),
  });
}

function remember(key: string, profile: DatasetQueryProfile): void {
  memoryProfiles.delete(key);
  memoryProfiles.set(key, profile);
  while (memoryProfiles.size > PROFILE_CACHE_MAX_ENTRIES) {
    const oldest = memoryProfiles.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    memoryProfiles.delete(oldest);
  }
}

async function acquireBuildSlot(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (activeBuilds < PROFILE_BUILD_CONCURRENCY) {
    activeBuilds += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const ready = () => {
      signal?.removeEventListener("abort", aborted);
      activeBuilds += 1;
      resolve();
    };
    const aborted = () => {
      const index = buildWaiters.indexOf(ready);
      if (index >= 0) buildWaiters.splice(index, 1);
      reject(new Error("dataset query profile build was cancelled"));
    };
    buildWaiters.push(ready);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function releaseBuildSlot(): void {
  activeBuilds -= 1;
  buildWaiters.shift()?.();
}

async function buildAndPersist(
  request: DatasetQueryProfileRequest,
  path: string,
  options: DatasetQueryProfileOptions,
): Promise<DatasetQueryProfile> {
  await acquireBuildSlot(options.signal);
  try {
    options.signal?.throwIfAborted();
    const profile = createProfile(request, await options.build(options.signal));
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(profile)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        signal: options.signal,
      });
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return profile;
  } finally {
    releaseBuildSlot();
  }
}

/**
 * Return a valid warm profile without starting remote metadata work.
 * Invalid disk entries are removed and never returned.
 */
export async function findDatasetQueryProfile(
  request: DatasetQueryProfileRequest,
  cacheDirectory?: string,
): Promise<DatasetQueryProfile | null> {
  const parsedRequest = profileRequestSchema.parse(request);
  const key = profileKey(parsedRequest);
  const remembered = memoryProfiles.get(key);
  if (remembered !== undefined) return remembered;
  const bundled = bundledProfiles.find(
    (profile) =>
      profile.dataset === parsedRequest.dataset &&
      profile.countyKey === parsedRequest.countyKey &&
      profile.sourceCid === parsedRequest.sourceCid,
  );
  if (bundled !== undefined) {
    const profile = validateProfile(bundled, parsedRequest);
    remember(key, profile);
    return profile;
  }
  const directory =
    cacheDirectory ??
    process.env.DATASET_QUERY_PROFILE_CACHE_DIRECTORY ??
    join(tmpdir(), "elephant-mcp-dataset-query-profiles");
  const path = profilePath(parsedRequest, directory);
  try {
    const cached = validateProfile(
      JSON.parse(await readFile(path, "utf8")),
      parsedRequest,
    );
    remember(key, cached);
    return cached;
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      await unlink(path).catch(() => undefined);
    }
    return null;
  }
}

/**
 * Read or build exact schema/count metadata bound to one immutable Parquet CID.
 * Malformed or identity-mismatched cache files are deleted and never served.
 */
export async function getDatasetQueryProfile(
  request: DatasetQueryProfileRequest,
  options: DatasetQueryProfileOptions,
): Promise<DatasetQueryProfile> {
  const parsedRequest = profileRequestSchema.parse(request);
  const key = profileKey(parsedRequest);
  const cacheDirectory =
    options.cacheDirectory ??
    process.env.DATASET_QUERY_PROFILE_CACHE_DIRECTORY ??
    join(tmpdir(), "elephant-mcp-dataset-query-profiles");
  await mkdir(cacheDirectory, { recursive: true });
  const path = profilePath(parsedRequest, cacheDirectory);
  const cached = await findDatasetQueryProfile(parsedRequest, cacheDirectory);
  if (cached !== null) return cached;

  let pending = pendingProfiles.get(key);
  if (pending === undefined) {
    pending = buildAndPersist(parsedRequest, path, options);
    pendingProfiles.set(key, pending);
    pending.finally(() => pendingProfiles.delete(key)).catch(() => undefined);
  }
  const profile = await pending;
  remember(key, profile);
  return profile;
}

/** Clear process-local profile state. Intended for tests and config reloads. */
export function clearDatasetQueryProfileCache(): void {
  memoryProfiles.clear();
  pendingProfiles.clear();
}

export const datasetQueryProfileInternals = {
  canonicalJson,
  sha256,
  validateProfile,
  createProfile,
};
