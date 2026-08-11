export { EmbeddingClient, type EmbeddingClientOptions } from "./embedding-client.js";
export { VectorIndex, getSourceType, chunkSizeFor, splitChunks, readManifestPaths } from "./indexer.js";
export { VectorDb } from "./vector-db.js";
export { VectorHit } from "./search.js";
export { hashText, cosineSimilarity, getKeywordTerms, searchKeywordsInChunks, mergeHits } from "./search.js";
export { hitExcerptLimit, excerptText, prepareQuery, sourceWeight } from "./search.js";
export { GraphContext } from "./graph-context.js";
export { GraphExtractor } from "./graph-extractor.js";
export { GraphConsistency } from "./graph-consistency.js";
export { GraphMemory } from "./graph-memory.js";
export type {
  ExtractGraphDataInput,
  ExtractGraphDataResult
} from "./graph-extractor.js";
export type {
  CheckDraftConsistencyOptions,
  GraphBlockingClaim,
  GraphConsistencyResult
} from "./graph-consistency.js";
export type {
  BuildWritingContextOptions,
  CheckGraphDraftConsistencyOptions,
  CheckGraphDraftConsistencyResult
} from "./graph-memory.js";
