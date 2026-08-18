import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";
import { getJsonByCid } from "../lib/ipfs.ts";
import { fetchManifest, normalizeKey } from "../lib/manifest.ts";
import type {
  ClassSchema,
  DataGroupSchema,
  ListedClassInfo,
  Manifest,
} from "../types/lexicon.ts";

export function extractClassPairs(relKey: string): [string, string] | null {
  if (relKey.includes("_has_"))
    return relKey.split("_has_") as [string, string];
  if (relKey.includes("_to_")) return relKey.split("_to_") as [string, string];
  return null;
}

export function shouldIgnoreClass(name: string): boolean {
  return (
    normalizeKey(name) === "fact_sheet" || normalizeKey(name) === "factsheet"
  );
}

export async function resolveDataGroup(
  manifest: Manifest,
  groupName: string,
): Promise<{ key: string; cid: string; available: string[] }> {
  const entries = Object.entries(manifest);
  const dataGroups = entries
    .filter(([, v]) => v.type === "dataGroup")
    .map(([k]) => k);

  const target = dataGroups.find(
    (k) => normalizeKey(k) === normalizeKey(groupName),
  );

  if (!target) {
    return {
      key: "",
      cid: "",
      available: dataGroups.sort(),
    };
  }

  return { key: target, cid: manifest[target].ipfsCid, available: dataGroups };
}

export async function listClassesFromDataGroup(
  manifest: Manifest,
  groupCid: string,
): Promise<ListedClassInfo[]> {
  const groupSchema = await getJsonByCid<DataGroupSchema>(groupCid);
  const relationshipsProperties = groupSchema.relationships?.properties;
  const nestedRelationshipsNode = groupSchema.properties?.relationships;
  const nestedRelationshipsProperties = nestedRelationshipsNode?.properties;
  const properties =
    relationshipsProperties ??
    // Handle real JSON Schema nesting where relationships live under properties.relationships.properties
    nestedRelationshipsProperties ??
    {};
  const candidate = new Set<string>();

  for (const [key, relSchema] of Object.entries(properties)) {
    // Skip deprecated relationships
    if (relSchema?.deprecated === true) {
      continue;
    }

    const pair = extractClassPairs(key);
    if (!pair) continue;
    const [a, b] = pair;
    if (!shouldIgnoreClass(a)) candidate.add(normalizeKey(a));
    if (!shouldIgnoreClass(b)) candidate.add(normalizeKey(b));
  }

  const classes: ListedClassInfo[] = [];
  for (const className of candidate) {
    const manifestKey = Object.keys(manifest).find(
      (k) => normalizeKey(k) === normalizeKey(className),
    );

    if (!manifestKey) {
      logger.warn("Class name not found in manifest", { className });
      continue;
    }

    const entry = manifest[manifestKey];
    if (entry.type !== "class") {
      continue;
    }

    let schema: ClassSchema | null = null;
    try {
      schema = await getJsonByCid<ClassSchema>(entry.ipfsCid);
    } catch (error) {
      logger.warn("Failed to fetch class schema", {
        classKey: manifestKey,
        cid: entry.ipfsCid,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const displayName = schema?.name ?? schema?.title ?? manifestKey;
    const description = schema?.description ?? null;
    classes.push({ key: manifestKey, name: displayName, description });
  }

  return classes.sort((a, b) => a.key.localeCompare(b.key));
}

export async function listClassesByDataGroupHandler(groupName: string) {
  try {
    const manifest = await fetchManifest();
    const resolved = await resolveDataGroup(manifest, groupName);

    if (!resolved.key) {
      const message = `Unknown data group '${groupName}'. Available: ${resolved.available.join(", ")}`;
      logger.warn(message);
      return createTextResult({ error: message });
    }

    const classes = await listClassesFromDataGroup(manifest, resolved.cid);
    return createTextResult({ classes });
  } catch (error) {
    logger.error("listClassesByDataGroup failed", {
      groupName,
      error: error instanceof Error ? error.message : String(error),
    });
    return createTextResult({ error: "Internal error while listing classes" });
  }
}
