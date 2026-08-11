import { GraphContext, type GraphClaim, type GraphEntity, type GraphRelation } from "./graph-context.js";

export interface ExtractGraphDataInput {
  chunkId: number;
  text: string;
  sourceType: string;
  sourcePath: string;
  chunkTitle: string;
}

export interface ExtractGraphDataResult {
  entities: GraphEntity[];
  relations: GraphRelation[];
  claims: GraphClaim[];
}

/**
 * Thin extraction facade for the P3 GraphMemory surface.
 *
 * The first P3 pass deliberately reuses GraphContext's existing rule-based
 * extractor so GraphMemory can be integrated without changing storage behavior.
 */
export class GraphExtractor {
  private readonly graphContext: GraphContext;

  constructor(projectPath: string) {
    this.graphContext = new GraphContext(projectPath);
  }

  extract(input: ExtractGraphDataInput): ExtractGraphDataResult {
    return this.graphContext.extractGraphData(
      input.chunkId,
      input.text,
      input.sourceType,
      input.sourcePath,
      input.chunkTitle
    );
  }

  close(): void {
    this.graphContext.close();
  }
}
