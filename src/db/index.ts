export { functionsTable, functionEmbeddingsTable } from "./schema.js";
export { initializeDatabase } from "./migrate.js";
export {
  saveFunction,
  getFunctionById,
  getFunctionsByFilePath,
  searchSimilar,
  deleteFunction,
} from "./repository.js";
export type {
  FunctionInput,
  FunctionWithChunks,
  VectorSearchResult,
} from "./types.js";
