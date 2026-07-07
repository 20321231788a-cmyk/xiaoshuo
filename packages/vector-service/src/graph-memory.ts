import { GraphConsistency, type CheckDraftConsistencyOptions, type GraphConsistencyResult } from "./graph-consistency.js";
import { GraphContext } from "./graph-context.js";

export interface BuildWritingContextOptions {
  topK?: number;
  maxChars?: number;
  chapter?: number;
}

export type CheckGraphDraftConsistencyOptions = CheckDraftConsistencyOptions;
export type CheckGraphDraftConsistencyResult = GraphConsistencyResult;

export class GraphMemory {
  private readonly graphContext: GraphContext;
  private readonly consistency: GraphConsistency;

  constructor(projectPath: string) {
    this.graphContext = new GraphContext(projectPath);
    this.consistency = new GraphConsistency(projectPath);
  }

  rebuild(): void {
    this.graphContext.rebuildGraph();
  }

  updatePaths(_paths: string[]): void {
    this.graphContext.rebuildGraph();
  }

  async buildWritingContext(query: string, options: BuildWritingContextOptions = {}): Promise<string> {
    const chapterQuery = options.chapter ? `${query} 第${options.chapter}章` : query;
    const context = await this.graphContext.buildWritingContext(chapterQuery, { topK: options.topK });

    if (options.maxChars && context.length > options.maxChars) {
      return context.slice(0, Math.max(0, options.maxChars)).trimEnd();
    }

    return context;
  }

  async checkDraftConsistency(
    text: string,
    options: CheckGraphDraftConsistencyOptions = {}
  ): Promise<CheckGraphDraftConsistencyResult> {
    return this.consistency.checkDraft(text, options);
  }

  close(): void {
    this.graphContext.close();
    this.consistency.close();
  }
}
