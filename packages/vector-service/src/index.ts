export { EmbeddingClient, type EmbeddingClientOptions } from "./embedding-client.js";
export { VectorIndex, getSourceType, chunkSizeFor, splitChunks, readManifestPaths } from "./indexer.js";
export { VectorDb } from "./vector-db.js";
export { VectorHit } from "./search.js";
export { hashText, cosineSimilarity, getKeywordTerms, searchKeywordsInChunks, mergeHits } from "./search.js";
export { hitExcerptLimit, excerptText, prepareQuery, sourceWeight } from "./search.js";
export { GraphContext } from "./graph-context.js";
