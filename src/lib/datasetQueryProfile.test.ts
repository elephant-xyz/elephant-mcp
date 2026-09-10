import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearDatasetQueryProfileCache,
  datasetQueryProfileInternals,
  findDatasetQueryProfile,
  getDatasetQueryProfile,
} from "./datasetQueryProfile.ts";

const CID_A = "QmQhc18TqKTjBymQkfxdsbWNg6SxrDmQ3bfYBJdWWdU7cF";
const CID_B = "QmcDAHJBt5LHiHAHdDwqCKM2BZqPwTJBrxW4Z5DJ6qEJd2";
const CID_C = "QmTZndCJfNi29hxGzyLXpt9iYJedtmeM2DKFRa24LLA6dq";
const directories: string[] = [];

async function cacheDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dataset-query-profile-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  clearDatasetQueryProfileCache();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("immutable dataset query metadata profiles", () => {
  it("ships the reviewed Broward property profile bound to its source CID", async () => {
    const profile = await findDatasetQueryProfile({
      dataset: "properties",
      countyKey: "broward",
      sourceCid: CID_A,
    });

    expect(profile).toMatchObject({
      rowCount: 526_068,
      schemaFingerprint:
        "2dc308275e2a7707c2390b43e565cae55960aeb10f4c4e76ba48481bd92d0642",
      profileIdentity:
        "ce80434105185f78e88e4beae467c84aab0201b71d4226f45941c8b6cdb97d7e",
    });
  });

  it("coalesces duplicate builds and reuses the exact cached profile", async () => {
    const directory = await cacheDirectory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const build = vi.fn(async () => {
      await gate;
      return {
        columns: [{ name: "address_zip", type: "VARCHAR" }],
        rowCount: 526_068,
      };
    });
    const request = {
      dataset: "properties" as const,
      countyKey: "fixture",
      sourceCid: CID_A,
    };

    const first = getDatasetQueryProfile(request, {
      cacheDirectory: directory,
      build,
    });
    const second = getDatasetQueryProfile(request, {
      cacheDirectory: directory,
      build,
    });
    release();

    const [left, right] = await Promise.all([first, second]);
    expect(build).toHaveBeenCalledOnce();
    expect(right).toEqual(left);
    expect(left).toMatchObject({
      sourceCid: CID_A,
      rowCount: 526_068,
      exact: true,
      origin: "immutable_parquet_metadata",
    });
  });

  it("invalidates by immutable CID and schema fingerprint", async () => {
    const directory = await cacheDirectory();
    const first = await getDatasetQueryProfile(
      {
        dataset: "properties",
        countyKey: "fixture",
        sourceCid: CID_A,
      },
      {
        cacheDirectory: directory,
        build: async () => ({
          columns: [{ name: "property_id", type: "VARCHAR" }],
          rowCount: 1,
        }),
      },
    );
    const second = await getDatasetQueryProfile(
      {
        dataset: "properties",
        countyKey: "fixture",
        sourceCid: CID_B,
      },
      {
        cacheDirectory: directory,
        build: async () => ({
          columns: [
            { name: "property_id", type: "VARCHAR" },
            { name: "market_value", type: "DOUBLE" },
          ],
          rowCount: 2,
        }),
      },
    );

    expect(second.sourceCid).toBe(CID_B);
    expect(second.schemaFingerprint).not.toBe(first.schemaFingerprint);
    expect(second.profileIdentity).not.toBe(first.profileIdentity);
  });

  it("fails closed on a malformed or source-stale disk profile", async () => {
    const directory = await cacheDirectory();
    const request = {
      dataset: "properties" as const,
      countyKey: "fixture",
      sourceCid: CID_A,
    };
    const path = join(directory, `properties-fixture-${CID_A}.json`);
    const stale = datasetQueryProfileInternals.createProfile(
      { ...request, sourceCid: CID_B },
      {
        columns: [{ name: "property_id", type: "VARCHAR" }],
        rowCount: 99,
      },
    );
    await writeFile(path, JSON.stringify(stale));

    await expect(
      getDatasetQueryProfile(request, {
        cacheDirectory: directory,
        build: async () => {
          throw new Error("immutable source unavailable");
        },
      }),
    ).rejects.toThrow("immutable source unavailable");
    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("limits independent cold profile builds to two at a time", async () => {
    const directory = await cacheDirectory();
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    let resolveTwoStarted!: () => void;
    const twoStarted = new Promise<void>((resolve) => {
      resolveTwoStarted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const build = async () => {
      active += 1;
      started += 1;
      maximumActive = Math.max(maximumActive, active);
      if (started === 2) resolveTwoStarted();
      await gate;
      active -= 1;
      return {
        columns: [{ name: "property_id", type: "VARCHAR" }],
        rowCount: 1,
      };
    };

    const profiles = [CID_A, CID_B, CID_C].map((sourceCid) =>
      getDatasetQueryProfile(
        {
          dataset: "properties",
          countyKey: "fixture",
          sourceCid,
        },
        { cacheDirectory: directory, build },
      ),
    );
    await twoStarted;
    expect(started).toBe(2);
    expect(maximumActive).toBe(2);
    release();
    await Promise.all(profiles);
    expect(started).toBe(3);
    expect(maximumActive).toBe(2);
  });
});
