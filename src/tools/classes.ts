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

    const keyToDescription = new Map<string, string | null>();

    const addProps = (node: JsonSchemaNode | null | undefined) => {
      if (node?.properties) {
        for (const [key, prop] of Object.entries(node.properties)) {
          // Skip deprecated properties
          if (prop?.deprecated === true) {
            continue;
          }
          
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

    // Check if the property itself is deprecated
    if (propSchema.deprecated === true) {
      const message = `Property '${propertyName}' is deprecated for class '${className}'.`;
      logger.warn(message);
      return createTextResult({ error: message });
    }

    // Filter out deprecated enum values
    const filteredSchema = { ...propSchema };
    if (filteredSchema.deprecated_enum_values && Array.isArray(filteredSchema.enum)) {
      const deprecatedValues = Array.isArray(filteredSchema.deprecated_enum_values)
        ? filteredSchema.deprecated_enum_values
        : Object.keys(filteredSchema.deprecated_enum_values);
      
      filteredSchema.enum = filteredSchema.enum.filter(
        (value) => !deprecatedValues.includes(String(value))
      );
      
      // Remove deprecated_enum_values from the returned schema
      delete filteredSchema.deprecated_enum_values;
    }

    return createTextResult({ schema: filteredSchema });
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
