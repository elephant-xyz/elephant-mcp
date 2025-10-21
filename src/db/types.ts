export interface FunctionWithChunks {
  id: number;
  name: string;
  code: string;
  filePath: string;
  embeddings: number[][];
}

export interface FunctionInput {
  name: string;
  code: string;
  filePath: string;
  embeddings: number[][];
}

export interface VectorSearchResult {
  function: FunctionWithChunks;
  distance: number;
}
