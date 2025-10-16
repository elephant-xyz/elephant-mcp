export type ManifestEntryType = "class" | "relationship" | "dataGroup";

export interface ManifestEntryBase {
  ipfsCid: string;
  type: ManifestEntryType;
}

export type Manifest = Record<string, ManifestEntryBase>;

export interface JsonSchemaNode extends Record<string, unknown> {
  description?: string | null;
  properties?: Record<string, JsonSchemaNode>;
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
}

export interface DataGroupSchema extends JsonSchemaNode {
  relationships?: {
    properties?: Record<string, JsonSchemaNode>;
  };
}

export interface ClassSchema extends JsonSchemaNode {
  name?: string;
  title?: string;
}

export interface ListedClassInfo {
  key: string;
  name: string;
  description: string | null;
}
