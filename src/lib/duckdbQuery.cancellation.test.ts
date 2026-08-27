import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const duckdbMocks = vi.hoisted(() => {
  let rejectActiveQuery: ((reason: Error) => void) | undefined;

  const run = vi.fn(async () => undefined);
  const runAndReadAll = vi.fn(
    () =>
      new Promise<never>((_resolve, reject) => {
        rejectActiveQuery = reject;
      }),
  );
  const interrupt = vi.fn(() => {
    rejectActiveQuery?.(new Error("DuckDB query interrupted"));
  });
  const connection = { run, runAndReadAll, interrupt };
  const connect = vi.fn(async () => connection);
  const create = vi.fn(async () => ({ connect }));

  return {
    connect,
    create,
    interrupt,
    run,
    runAndReadAll,
    resetActiveQuery: () => {
      rejectActiveQuery = undefined;
    },
  };
});

vi.mock("@duckdb/node-api", () => ({
  DuckDBInstance: { create: duckdbMocks.create },
}));

vi.mock("../logger.ts", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  clearPropertyQueryConnections,
  runInternalPropertyQuery,
  runPropertyQuery,
} from "./duckdbQuery.ts";

describe("DuckDB property query cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    duckdbMocks.resetActiveQuery();
    process.env.PROPERTY_QUERY_TABLE = "/tmp/properties.parquet";
    delete process.env.PROPERTY_QUERY_TABLE_MAP;
    delete process.env.PROPERTY_QUERY_TABLE_DEFAULT_COUNTY;
    clearPropertyQueryConnections();
  });

  afterEach(() => {
    delete process.env.PROPERTY_QUERY_TABLE;
    clearPropertyQueryConnections();
  });

  it("interrupts the active DuckDB operation when its request aborts", async () => {
    const controller = new AbortController();
    const queryPromise = runPropertyQuery(
      "lee",
      "SELECT count(*) AS property_count FROM properties",
      1,
      controller.signal,
    );

    await vi.waitFor(() => {
      expect(duckdbMocks.runAndReadAll).toHaveBeenCalledOnce();
    });
    controller.abort(new Error("caller-controlled secret reason"));

    await expect(queryPromise).rejects.toThrow(
      "Property query was cancelled during execution.",
    );
    expect(duckdbMocks.interrupt).toHaveBeenCalledOnce();
  });

  it("does not start a query whose request is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runPropertyQuery(
        "lee",
        "SELECT count(*) AS property_count FROM properties",
        1,
        controller.signal,
      ),
    ).rejects.toThrow("Property query was cancelled before execution.");
    expect(duckdbMocks.runAndReadAll).not.toHaveBeenCalled();
    expect(duckdbMocks.interrupt).not.toHaveBeenCalled();
  });

  it("interrupts the internal dataset-info aggregate when aborted", async () => {
    const controller = new AbortController();
    const queryPromise = runInternalPropertyQuery(
      "lee",
      "SELECT count(*) AS c FROM properties",
      [],
      controller.signal,
    );

    await vi.waitFor(() => {
      expect(duckdbMocks.runAndReadAll).toHaveBeenCalledOnce();
    });
    controller.abort();

    await expect(queryPromise).rejects.toThrow(
      "Property query was cancelled during execution.",
    );
    expect(duckdbMocks.interrupt).toHaveBeenCalledOnce();
  });
});
