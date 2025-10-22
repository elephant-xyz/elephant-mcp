export {
  functionsTable,
  functionEmbeddingsTable,
  indexStateTable,
} from "./schema.js";
export { initializeDatabase } from "./migrate.js";
export {
  saveFunction,
  getFunctionById,
  getFunctionsByFilePath,
  searchSimilar,
  deleteFunction,
  getIndexState,
  setIndexState,
} from "./repository.js";
export type {
  FunctionInput,
  FunctionWithChunks,
  VectorSearchResult,
} from "./types.js";
