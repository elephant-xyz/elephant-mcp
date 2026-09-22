import { describe, expect, it } from "vitest";

import { parseAtlasDatabaseUrl } from "./backend.ts";

describe("Atlas database URL", () => {
  it("defaults to a separate SQLite database", () => {
    expect(parseAtlasDatabaseUrl(undefined, "/tmp/elephant")).toEqual({
      kind: "sqlite",
      databaseUrl: "file:///tmp/elephant/atlas/atlas.sqlite",
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
