export type ManifestEntryType = "class" | "relationship" | "dataGroup";

export interface ManifestEntryBase {
  ipfsCid: string;
  type: ManifestEntryType;
}

export type Manifest = Record<string, ManifestEntryBase>;

export interface DataGroupSchema {
  relationships?: {
    properties?: Record<string, unknown>;
  };
}

export interface ClassSchema {
  name?: string;
  title?: string;
  description?: string;
}

export interface ListedClassInfo {
  key: string;
  name: string;
  description: string | null;
}
