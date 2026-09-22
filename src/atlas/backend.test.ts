import { describe, expect, it } from "vitest";

import {
  getDefaultAtlasDatabaseUrl,
  parseAtlasDatabaseUrl,
} from "./backend.ts";

describe("Atlas database URL", () => {
  it("defaults to a separate SQLite database", () => {
    const url = getDefaultAtlasDatabaseUrl("/tmp/elephant");

    expect(url).toBe("file:///tmp/elephant/atlas/atlas.sqlite");
    expect(parseAtlasDatabaseUrl(undefined, "/tmp/elephant")).toEqual({
      kind: "sqlite",
      databaseUrl: url,
      filePath: "/tmp/elephant/atlas/atlas.sqlite",
    });
  });

  it("accepts file and Postgres URLs", () => {
    expect(parseAtlasDatabaseUrl("file:///tmp/custom.sqlite")).toMatchObject({
      kind: "sqlite",
      filePath: "/tmp/custom.sqlite",
    });
    expect(
      parseAtlasDatabaseUrl("postgres://user:secret@example.com/atlas"),
    ).toEqual({
      kind: "postgres",
      databaseUrl: "postgres://user:secret@example.com/atlas",
    });
    expect(
      parseAtlasDatabaseUrl("postgresql://user:secret@example.com/atlas"),
    ).toEqual({
      kind: "postgres",
      databaseUrl: "postgresql://user:secret@example.com/atlas",
    });
  });

  it("rejects unsupported and ambiguous SQLite URLs", () => {
    expect(() => parseAtlasDatabaseUrl("https://example.com/db")).toThrow(
      "file:, postgres://, or postgresql://",
    );
    expect(() =>
      parseAtlasDatabaseUrl("file:///tmp/atlas.sqlite?mode=ro"),
    ).toThrow("must not contain query");
  });
});
