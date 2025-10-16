import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";
import { getJsonByCid } from "../lib/ipfs.ts";
import { fetchManifest, normalizeKey } from "../lib/manifest.ts";
import type { ClassSchema, Manifest } from "../types/lexicon.ts";

function resolveClass(
  manifest: Manifest,
  className: string,
): { key: string; cid: string; available: string[] } {
  const entries = Object.entries(manifest);
  const classKeys = entries
    .filter(([, v]) => v.type === "class")
    .map(([k]) => k);

  const target = classKeys.find(
    (k) => normalizeKey(k) === normalizeKey(className),
  );
  if (!target) {
    return { key: "", cid: "", available: classKeys.sort() };
  }

  return { key: target, cid: manifest[target].ipfsCid, available: classKeys };
}

export async function listPropertiesByClassNameHandler(className: string) {
  try {
    const manifest = await fetchManifest();
    const resolved = resolveClass(manifest, className);

    if (!resolved.key) {
      const message = `Unknown class '${className}'. Available: ${resolved.available.join(", ")}`;
      logger.warn(message);
      return createTextResult({ error: message });
    }

    let schema: ClassSchema | null = null;
    try {
      schema = await getJsonByCid<ClassSchema>(resolved.cid);
    } catch (error) {
      logger.error("Failed to fetch class schema", {
        className,
        cid: resolved.cid,
        error: error instanceof Error ? error.message : String(error),
      });
      return createTextResult({ error: "Failed to fetch class schema" });
    }

    const s: any = schema as any;
    const keyToDescription = new Map<string, string | null>();

    const addProps = (node: any) => {
      if (
        node &&
        typeof node === "object" &&
        node.properties &&
        typeof node.properties === "object"
      ) {
        for (const key of Object.keys(node.properties)) {
          const prop = node.properties[key];
          const desc =
            prop && typeof prop === "object"
              ? ((prop as any).description ?? null)
              : null;
          // Prefer first found description; if not set yet or existing is null and new has value, set it
          if (!keyToDescription.has(key)) {
            keyToDescription.set(key, desc ?? null);
          } else {
            const existing = keyToDescription.get(key);
            if ((existing == null || existing === "") && desc) {
              keyToDescription.set(key, desc);
            }
          }
        }
      }
    };

    // Direct properties
    addProps(s);
    // Union across common JSON Schema combinators
    for (const comb of ["oneOf", "allOf", "anyOf"] as const) {
      const arr = Array.isArray(s?.[comb]) ? (s[comb] as any[]) : [];
      for (const sub of arr) addProps(sub);
    }

    const properties = Array.from(keyToDescription.entries())
      .filter(([k]) => normalizeKey(k) !== "source_http_request")
      .map(([key, description]) => ({ key, description: description ?? null }))
      .sort((a, b) => a.key.localeCompare(b.key));

    return createTextResult({ properties });
  } catch (error) {
    logger.error("listPropertiesByClassName failed", {
      className,
      error: error instanceof Error ? error.message : String(error),
    });
    return createTextResult({
      error: "Internal error while listing properties",
    });
  }
}

function findPropertySchema(node: any, targetName: string): any | null {
  if (!node || typeof node !== "object") return null;

  const props = node.properties;
  if (props && typeof props === "object") {
    for (const key of Object.keys(props)) {
      if (normalizeKey(key) === normalizeKey(targetName)) {
        return props[key];
      }
    }
  }

  for (const comb of ["oneOf", "allOf", "anyOf"] as const) {
    const arr = Array.isArray(node?.[comb]) ? (node[comb] as any[]) : [];
    for (const sub of arr) {
      const found = findPropertySchema(sub, targetName);
      if (found) return found;
    }
  }

  return null;
}

export async function getPropertySchemaByClassNameHandler(
  className: string,
  propertyName: string,
) {
  try {
    const manifest = await fetchManifest();
    const resolved = resolveClass(manifest, className);

    if (!resolved.key) {
      const message = `Unknown class '${className}'.`;
      logger.warn(message);
      return createTextResult({ error: message });
    }

    let schema: any = null;
    try {
      schema = await getJsonByCid<any>(resolved.cid);
    } catch (error) {
      logger.error("Failed to fetch class schema", {
        className,
        cid: resolved.cid,
        error: error instanceof Error ? error.message : String(error),
      });
      return createTextResult({ error: "Failed to fetch class schema" });
    }

    const propSchema = findPropertySchema(schema, propertyName);
    if (!propSchema) {
      const message = `Property '${propertyName}' not found for class '${className}'.`;
      logger.warn(message);
      return createTextResult({ error: message });
    }

    return createTextResult({ schema: propSchema });
  } catch (error) {
    logger.error("getPropertySchema failed", {
      className,
      propertyName,
      error: error instanceof Error ? error.message : String(error),
    });
    return createTextResult({
      error: "Internal error while getting property schema",
    });
  }
}
