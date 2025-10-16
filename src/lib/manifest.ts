import { z } from "zod";
import type { Manifest } from "../types/lexicon.ts";

export const MANIFEST_URL =
  "https://lexicon.elephant.xyz/json-schemas/schema-manifest.json";

export const manifestSchema = z.record(
  z.object({
    ipfsCid: z.string(),
    type: z.enum(["class", "relationship", "dataGroup"]),
  }),
);

export function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

export async function fetchManifest(): Promise<Manifest> {
  const res = await fetch(MANIFEST_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch manifest: ${res.status} ${res.statusText}`,
    );
  }
  const json = await res.json();
  const parsed = manifestSchema.parse(json);
  return parsed as Manifest;
}
