import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";
import { getJsonByCid } from "../lib/ipfs.ts";
import { fetchManifest, normalizeKey } from "../lib/manifest.ts";
import type {
  ClassSchema,
  JsonSchemaNode,
  Manifest,
} from "../types/lexicon.ts";

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

export async function listPropertiesByClassNameHandler(
  className: string,
  withTypes = false,
) {
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

    const keyToDescription = new Map<string, string | null>();
    const keyToSchema = new Map<string, JsonSchemaNode>();

    const addProps = (node: JsonSchemaNode | null | undefined) => {
      if (node?.properties) {
        for (const [key, prop] of Object.entries(node.properties)) {
          const description = prop?.description ?? null;
          // Prefer first found description; if not set yet or existing is null and new has value, set it
          if (!keyToDescription.has(key)) {
            keyToDescription.set(key, description);
          } else {
            const existing = keyToDescription.get(key);
            if ((existing == null || existing === "") && description) {
              keyToDescription.set(key, description);
            }
          }

          if (!keyToSchema.has(key)) {
            // Capture the first encountered schema node for this key
            const captured: JsonSchemaNode = { ...(prop as JsonSchemaNode) };
            if (key === "property_type") {
              // Inject enum options for property_type for better UX
              captured["enum"] = [
                "LandParcel",
                "Building",
                "Unit",
                "ManufacturedHome",
              ];
            }
            keyToSchema.set(key, captured);
          }
        }
      }
    };

    // Direct properties
    addProps(schema);
    // Union across common JSON Schema combinators
    for (const comb of ["oneOf", "allOf", "anyOf"] as const) {
      const candidates = schema?.[comb];
      if (Array.isArray(candidates)) {
        for (const sub of candidates) addProps(sub);
      }
    }

    const properties = Array.from(keyToDescription.entries())
      .filter(([k]) => normalizeKey(k) !== "source_http_request")
      .map(([key, description]) => {
        if (withTypes) {
          // When including types, avoid duplicating description at the root level.
          // The full schema (including description) will be returned under `schema`.
          return { key, schema: keyToSchema.get(key) ?? {} } as {
            key: string;
            schema: JsonSchemaNode;
          };
        }
        return { key, description: description ?? null } as {
          key: string;
          description: string | null;
        };
      })
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

function findPropertySchema(
  node: JsonSchemaNode | null | undefined,
  targetName: string,
): JsonSchemaNode | null {
  if (!node) return null;

  const props = node.properties;
  if (props && typeof props === "object") {
    for (const key of Object.keys(props)) {
      if (normalizeKey(key) === normalizeKey(targetName)) {
        if (key === "property_type") {
          const schema = props[key];
          schema["enum"] = [
            "LandParcel",
            "Building",
            "Unit",
            "ManufacturedHome",
          ];
        }
        return props[key];
      }
    }
  }

  for (const comb of ["oneOf", "allOf", "anyOf"] as const) {
    const candidates = node?.[comb];
    if (Array.isArray(candidates)) {
      for (const sub of candidates) {
        const found = findPropertySchema(sub, targetName);
        if (found) return found;
      }
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

    let schema: ClassSchema;
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
