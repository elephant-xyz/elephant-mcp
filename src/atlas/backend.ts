import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { getDefaultDataDir } from "../lib/paths.ts";

export type AtlasBackend =
  | {
      kind: "sqlite";
      databaseUrl: string;
      filePath: string;
    }
  | {
      kind: "postgres";
      databaseUrl: string;
    };

export function getDefaultAtlasDatabaseUrl(
  dataDir = getDefaultDataDir(),
): string {
  return pathToFileURL(path.join(dataDir, "atlas", "atlas.sqlite")).href;
}

export function parseAtlasDatabaseUrl(
  value: string | undefined,
  dataDir = getDefaultDataDir(),
): AtlasBackend {
  const databaseUrl = value ?? getDefaultAtlasDatabaseUrl(dataDir);
  let url: URL;

  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(
      "DATABASE_URL must be a file:, postgres://, or postgresql:// URL",
    );
  }

  if (url.protocol === "file:") {
    if (url.search !== "" || url.hash !== "") {
      throw new Error(
        "SQLite DATABASE_URL must not contain query or hash data",
      );
    }
    return {
      kind: "sqlite",
      databaseUrl: url.href,
      filePath: fileURLToPath(url),
    };
  }

  if (url.protocol === "postgres:" || url.protocol === "postgresql:") {
    return { kind: "postgres", databaseUrl };
  }

  throw new Error("DATABASE_URL must use file:, postgres://, or postgresql://");
}
