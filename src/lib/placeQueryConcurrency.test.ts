import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const duckdb = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi.fn(),
  run: vi.fn(),
  interrupt: vi.fn(),
  closeSync: vi.fn(),
}));

vi.mock("@duckdb/node-api", () => ({
  DuckDBInstance: {
    create: duckdb.create,
  },
}));

import {
  clearPlaceQueryCaches,
  withPlaceConnection,
  type PublishedPlacesDataset,
} from "./placeQuery.ts";

const DATASET: PublishedPlacesDataset = {
  countyKey: "lee",
  countyName: "Lee",
  stateCode: "FL",
  countyFips: "12071",
  updatedAt: "2026-08-14T00:00:00.000Z",
  tableUrl: "https://ipfs.filebase.io/ipns/test/lee/places-table.parquet",
  indexUrl: "https://ipfs.filebase.io/ipns/test/lee/index.json",
  noticeUrl: "https://ipfs.filebase.io/ipns/test/NOTICE.txt",
};

describe("places connection concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await clearPlaceQueryCaches();
  });

  it("does not let one aborted caller reject shared connection setup", async () => {
    let releaseSetup: (() => void) | undefined;
    let rejectSetup: ((reason?: unknown) => void) | undefined;
    const setup = new Promise<void>((resolve, reject) => {
      releaseSetup = resolve;
      rejectSetup = reject;
    });
    const connection = {
      run: duckdb.run,
      interrupt: duckdb.interrupt,
      closeSync: duckdb.closeSync,
    };
    duckdb.create.mockResolvedValue({ connect: duckdb.connect });
    duckdb.connect.mockResolvedValue(connection);
    duckdb.run.mockReturnValueOnce(setup).mockResolvedValue(undefined);
    duckdb.interrupt.mockImplementation(() => {
      rejectSetup?.(new Error("shared setup interrupted"));
    });

    const controller = new AbortController();
    const aborted = withPlaceConnection(
      DATASET,
      async () => "aborted caller completed",
      { abortSignal: controller.signal },
    );
    const unaffected = withPlaceConnection(
      DATASET,
      async () => "unaffected caller completed",
    );

    await vi.waitFor(() => expect(duckdb.run).toHaveBeenCalledTimes(1));
    controller.abort();
    releaseSetup?.();

    await expect(aborted).rejects.toThrow(/aborted before execution/);
    await expect(unaffected).resolves.toBe("unaffected caller completed");
    expect(duckdb.interrupt).not.toHaveBeenCalled();
  });
});
