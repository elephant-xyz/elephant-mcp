import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listPropertiesByClassNameHandler,
  getPropertySchemaByClassNameHandler,
} from "./classes.ts";
import { fetchManifest } from "../lib/manifest.ts";
import type { Manifest, ClassSchema } from "../types/lexicon.ts";

// Mock IPFS JSON fetcher
vi.mock("../lib/ipfs.ts", () => ({
  getJsonByCid: vi.fn(),
}));

// Mock manifest fetcher
vi.mock("../lib/manifest.ts", () => ({
  fetchManifest: vi.fn(),
  normalizeKey: (key: string) => key.trim().toLowerCase(),
}));

const { getJsonByCid } = await import("../lib/ipfs.ts");
const mockGetJsonByCid = vi.mocked(getJsonByCid);
const mockFetchManifest = vi.mocked(fetchManifest);

describe("listPropertiesByClassNameHandler", () => {
  const manifest: Manifest = {
    property: { ipfsCid: "cid-property", type: "class" },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockFetchManifest.mockResolvedValue(manifest);
  });

  it("should filter out deprecated properties", async () => {
    const schema: ClassSchema = {
      properties: {
        id: {
          type: "string",
          description: "Unique identifier",
        },
        deprecatedField: {
          type: "string",
          description: "This field is deprecated",
          deprecated: true,
        },
        activeField: {
          type: "number",
          description: "This field is active",
        },
      },
    };

    mockGetJsonByCid.mockResolvedValue(schema);

    const result = await listPropertiesByClassNameHandler("property");
    const resultData = JSON.parse(result.content[0].text);

    expect(resultData.properties).toHaveLength(2);
    expect(resultData.properties.map((p: { key: string }) => p.key)).toEqual([
      "activeField",
      "id",
    ]);
    expect(
      resultData.properties.find((p: { key: string }) => p.key === "deprecatedField"),
    ).toBeUndefined();
  });

  it("should include non-deprecated properties", async () => {
    const schema: ClassSchema = {
      properties: {
        id: {
          type: "string",
          description: "Unique identifier",
        },
        name: {
          type: "string",
          description: "Property name",
        },
      },
    };

    mockGetJsonByCid.mockResolvedValue(schema);

    const result = await listPropertiesByClassNameHandler("property");
    const resultData = JSON.parse(result.content[0].text);

    expect(resultData.properties).toHaveLength(2);
    expect(resultData.properties.map((p: { key: string }) => p.key)).toEqual([
      "id",
      "name",
    ]);
  });

  it("should handle properties with deprecated: false", async () => {
    const schema: ClassSchema = {
      properties: {
        activeField: {
          type: "string",
          description: "Active field",
          deprecated: false,
        },
      },
    };

    mockGetJsonByCid.mockResolvedValue(schema);

    const result = await listPropertiesByClassNameHandler("property");
    const resultData = JSON.parse(result.content[0].text);

    expect(resultData.properties).toHaveLength(1);
    expect(resultData.properties[0].key).toBe("activeField");
  });

  it("should filter deprecated properties from oneOf schemas", async () => {
    const schema: ClassSchema = {
      oneOf: [
        {
          properties: {
            id: { type: "string", description: "ID" },
            deprecatedProp: {
              type: "string",
              description: "Deprecated",
              deprecated: true,
            },
          },
        },
      ],
    };

    mockGetJsonByCid.mockResolvedValue(schema);

    const result = await listPropertiesByClassNameHandler("property");
    const resultData = JSON.parse(result.content[0].text);

    expect(resultData.properties).toHaveLength(1);
    expect(resultData.properties[0].key).toBe("id");
  });
});

describe("getPropertySchemaByClassNameHandler", () => {
  const manifest: Manifest = {
    property: { ipfsCid: "cid-property", type: "class" },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockFetchManifest.mockResolvedValue(manifest);
  });

  it("should return error for deprecated properties", async () => {
    const schema: ClassSchema = {
      properties: {
        deprecatedField: {
          type: "string",
          description: "This field is deprecated",
          deprecated: true,
        },
      },
    };

    mockGetJsonByCid.mockResolvedValue(schema);

    const result = await getPropertySchemaByClassNameHandler(
      "property",
      "deprecatedField",
    );
    const resultData = JSON.parse(result.content[0].text);

    expect(resultData.error).toContain("deprecated");
  });

  it("should filter out deprecated enum values", async () => {
    const schema: ClassSchema = {
      properties: {
        status: {
          type: "string",
          enum: ["active", "pending", "deprecated_status", "inactive"],
          deprecated_enum_values: ["deprecated_status"],
        },
      },
    };

    mockGetJsonByCid.mockResolvedValue(schema);

    const result = await getPropertySchemaByClassNameHandler("property", "status");
    const resultData = JSON.parse(result.content[0].text);

    expect(resultData.schema.enum).toEqual(["active", "pending", "inactive"]);
    expect(resultData.schema.enum).not.toContain("deprecated_status");
    expect(resultData.schema.deprecated_enum_values).toBeUndefined();
  });

  it("should handle deprecated_enum_values as array", async () => {
    const schema: ClassSchema = {
      properties: {
        type: {
          type: "string",
          enum: ["type1", "type2", "old_type", "type3"],
          deprecated_enum_values: ["old_type"],
        },
      },
    };

    mockGetJsonByCid.mockResolvedValue(schema);

    const result = await getPropertySchemaByClassNameHandler("property", "type");
    const resultData = JSON.parse(result.content[0].text);

    expect(resultData.schema.enum).toEqual(["type1", "type2", "type3"]);
    expect(resultData.schema.enum).not.toContain("old_type");
  });

  it("should handle deprecated_enum_values as object", async () => {
    const schema: ClassSchema = {
      properties: {
        category: {
          type: "string",
          enum: ["cat1", "cat2", "old_cat"],
          deprecated_enum_values: {
            old_cat: true,
          },
        },
      },
    };

    mockGetJsonByCid.mockResolvedValue(schema);

    const result = await getPropertySchemaByClassNameHandler(
      "property",
      "category",
    );
    const resultData = JSON.parse(result.content[0].text);

    expect(resultData.schema.enum).toEqual(["cat1", "cat2"]);
    expect(resultData.schema.enum).not.toContain("old_cat");
  });

  it("should return schema for non-deprecated properties", async () => {
    const schema: ClassSchema = {
      properties: {
        name: {
          type: "string",
          description: "Property name",
        },
      },
    };

    mockGetJsonByCid.mockResolvedValue(schema);

    const result = await getPropertySchemaByClassNameHandler("property", "name");
    const resultData = JSON.parse(result.content[0].text);

    expect(resultData.schema).toEqual({
      type: "string",
      description: "Property name",
    });
  });

  it("should handle properties without deprecated fields", async () => {
    const schema: ClassSchema = {
      properties: {
        id: {
          type: "string",
          enum: ["value1", "value2"],
        },
      },
    };

    mockGetJsonByCid.mockResolvedValue(schema);

    const result = await getPropertySchemaByClassNameHandler("property", "id");
    const resultData = JSON.parse(result.content[0].text);

    expect(resultData.schema.enum).toEqual(["value1", "value2"]);
  });
});

