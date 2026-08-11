export interface ContextBlock {
  id: string;
  path: string;
  content: string;
  type: string; // e.g. 'web' | 'document' | 'cache' | 'system' | 'user'
  relevance: number;  // 0.0 to 1.0
  priority: number;   // 0.0 to 1.0
  trust: number;      // 0.0 to 1.0
  freshness: number;  // 0.0 to 1.0
  allowInstruction?: boolean;
  tokenCount?: number;
}

export interface SchedulerConfig {
  modelContextLimit: number;
  toolDefinitionsMargin: number;
  systemReserve: number;
  tokenizer?: (text: string) => number;
}

export const defaultTokenizer = (text: string): number => {
  return Math.ceil(text.length / 4);
};

/**
 * Calculates the Jaccard similarity between two texts based on word overlap.
 */
export function calculateSimilarity(text1: string, text2: string): number {
  const wordPattern = /\w+/g;
  const words1 = new Set(text1.toLowerCase().match(wordPattern) || []);
  const words2 = new Set(text2.toLowerCase().match(wordPattern) || []);

  if (words1.size === 0 && words2.size === 0) return 1.0;
  if (words1.size === 0 || words2.size === 0) return 0.0;

  let intersection = 0;
  for (const word of words1) {
    if (words2.has(word)) {
      intersection++;
    }
  }
  const union = words1.size + words2.size - intersection;
  return intersection / union;
}

/**
 * Helper to fall back to text truncation using character slicing.
 */
function fallbackTextTruncate(
  content: string,
  maxTokens: number,
  tokenizer: (text: string) => number,
  truncationSign: string
): string {
  const signTokens = tokenizer(truncationSign);
  if (maxTokens <= signTokens) {
    return truncationSign;
  }

  let low = 0;
  let high = content.length;
  let bestContent = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const subStr = content.substring(0, mid);
    const tempText = subStr + truncationSign;
    if (tokenizer(tempText) <= maxTokens) {
      bestContent = subStr;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return bestContent + truncationSign;
}

/**
 * Truncates JSON contents.
 */
function truncateJson(
  content: string,
  maxTokens: number,
  tokenizer: (text: string) => number
): string {
  const truncationSign = "\n... [Truncated JSON Context] ...";
  const signTokens = tokenizer(truncationSign);

  if (maxTokens <= signTokens) {
    return truncationSign;
  }

  try {
    const obj = JSON.parse(content);

    if (Array.isArray(obj)) {
      let low = 0;
      let high = obj.length;
      let bestContent = "";

      const emptyModified = [{ _truncated: `Array truncated, remaining ${obj.length} items omitted` }];
      const emptySerialized = JSON.stringify(emptyModified, null, 2);
      if (tokenizer(emptySerialized) > maxTokens) {
        return fallbackTextTruncate(content, maxTokens, tokenizer, truncationSign);
      }

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const sliced = obj.slice(0, mid);
        const modified = [...sliced, { _truncated: `Array truncated, remaining ${obj.length - mid} items omitted` }];
        const serialized = JSON.stringify(modified, null, 2);
        if (tokenizer(serialized) <= maxTokens) {
          bestContent = serialized;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return bestContent || JSON.stringify(emptyModified, null, 2);
    } else if (typeof obj === 'object' && obj !== null) {
      const keys = Object.keys(obj);
      let low = 0;
      let high = keys.length;
      const originalSerialized = JSON.stringify(obj, null, 2);

      if (tokenizer(originalSerialized) <= maxTokens) {
        return originalSerialized;
      }

      let bestContent = "";

      const emptyModified = { _truncated: `Object keys truncated, remaining ${keys.length} keys omitted` };
      const emptySerialized = JSON.stringify(emptyModified, null, 2);
      if (tokenizer(emptySerialized) > maxTokens) {
        return fallbackTextTruncate(content, maxTokens, tokenizer, truncationSign);
      }

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const subObj: Record<string, any> = {};
        for (let i = 0; i < mid; i++) {
          const key = keys[i];
          if (key !== undefined) {
            subObj[key] = obj[key];
          }
        }
        subObj._truncated = `Object keys truncated, remaining ${keys.length - mid} keys omitted`;
        const serialized = JSON.stringify(subObj, null, 2);
        if (tokenizer(serialized) <= maxTokens) {
          bestContent = serialized;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return bestContent || JSON.stringify(emptyModified, null, 2);
    }
  } catch (e) {
    // Parse error, fallback
  }

  return fallbackTextTruncate(content, maxTokens, tokenizer, truncationSign);
}

/**
 * Truncates Markdown contents by heading sections/paragraphs.
 */
function truncateMarkdown(
  content: string,
  maxTokens: number,
  tokenizer: (text: string) => number
): string {
  const truncationSign = "\n\n... [Truncated Markdown Context] ...";
  const signTokens = tokenizer(truncationSign);

  if (maxTokens <= signTokens) {
    return truncationSign;
  }

  const parts = content.split(/\n\n+/);
  let accumulated = "";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    const separator = i === 0 ? "" : "\n\n";
    const tempText = accumulated + separator + part;
    const tempTokens = tokenizer(tempText + truncationSign);

    if (tempTokens <= maxTokens) {
      accumulated = tempText;
    } else {
      break;
    }
  }

  if (accumulated === "") {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const separator = i === 0 ? "" : "\n";
      const tempText = accumulated + separator + line;
      const tempTokens = tokenizer(tempText + truncationSign);

      if (tempTokens <= maxTokens) {
        accumulated = tempText;
      } else {
        break;
      }
    }
  }

  if (accumulated === "") {
    return fallbackTextTruncate(content, maxTokens, tokenizer, truncationSign);
  }

  return accumulated + truncationSign;
}

/**
 * Truncates text by paragraphs.
 */
function truncateParagraphs(
  content: string,
  maxTokens: number,
  tokenizer: (text: string) => number
): string {
  const truncationSign = "\n\n... [Truncated Paragraph Context] ...";
  const signTokens = tokenizer(truncationSign);

  if (maxTokens <= signTokens) {
    return truncationSign;
  }

  const parts = content.split(/\n\n+/);
  let accumulated = "";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    const separator = i === 0 ? "" : "\n\n";
    const tempText = accumulated + separator + part;
    const tempTokens = tokenizer(tempText + truncationSign);

    if (tempTokens <= maxTokens) {
      accumulated = tempText;
    } else {
      break;
    }
  }

  if (accumulated === "") {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const separator = i === 0 ? "" : "\n";
      const tempText = accumulated + separator + line;
      const tempTokens = tokenizer(tempText + truncationSign);

      if (tempTokens <= maxTokens) {
        accumulated = tempText;
      } else {
        break;
      }
    }
  }

  if (accumulated === "") {
    return fallbackTextTruncate(content, maxTokens, tokenizer, truncationSign);
  }

  return accumulated + truncationSign;
}

/**
 * High-level truncation router selecting the appropriate semantic partition cut.
 */
export function truncateBlockContent(
  content: string,
  path: string,
  maxTokens: number,
  tokenizer: (text: string) => number,
  blockType?: string
): string {
  let contentType: 'markdown' | 'json' | 'paragraphs' = 'paragraphs';

  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown')) {
    contentType = 'markdown';
  } else if (lowerPath.endsWith('.json')) {
    contentType = 'json';
  } else if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
    contentType = 'json';
  } else if (content.includes('# ') || content.includes('## ')) {
    contentType = 'markdown';
  }

  if (contentType === 'json') {
    return truncateJson(content, maxTokens, tokenizer);
  } else if (contentType === 'markdown') {
    return truncateMarkdown(content, maxTokens, tokenizer);
  } else {
    return truncateParagraphs(content, maxTokens, tokenizer);
  }
}

/**
 * ContextScheduler selects blocks based on model context limit, tool definition margins,
 * system reserve, MMR scoring weights, and enforces safety / quota limits.
 */
export class ContextScheduler {
  private config: SchedulerConfig;
  private tokenizer: (text: string) => number;

  constructor(config: SchedulerConfig) {
    this.config = config;
    this.tokenizer = config.tokenizer || defaultTokenizer;
  }

  public schedule(candidates: ContextBlock[]): ContextBlock[] {
    const totalBudget = this.config.modelContextLimit - this.config.toolDefinitionsMargin - this.config.systemReserve;
    if (totalBudget <= 0) {
      return [];
    }

    // Force allow_instruction: false on untrusted contexts (web, document, cache)
    const sanitizedCandidates: ContextBlock[] = candidates.map(block => {
      const lowerType = block.type.toLowerCase();
      const isUntrusted = lowerType === 'web' || lowerType === 'document' || lowerType === 'cache';
      return {
        ...block,
        allowInstruction: isUntrusted ? false : (block.allowInstruction ?? false),
      };
    });

    const selected: ContextBlock[] = [];
    let usedTokens = 0;
    const pathCounts: Record<string, number> = {};
    const remaining = [...sanitizedCandidates];

    while (remaining.length > 0) {
      // Enforce path quotas: max 2 segments per unique path
      const allowedCandidates = remaining.filter(block => {
        const count = pathCounts[block.path] || 0;
        return count < 2;
      });

      if (allowedCandidates.length === 0) {
        break;
      }

      let bestBlock: ContextBlock | null = null;
      let bestScore = -Infinity;
      let bestIndexInRemaining = -1;

      for (const block of allowedCandidates) {
        let novelty = 1.0;
        if (selected.length > 0) {
          let maxSimilarity = 0;
          for (const s of selected) {
            const sim = calculateSimilarity(block.content, s.content);
            if (sim > maxSimilarity) {
              maxSimilarity = sim;
            }
          }
          novelty = 1.0 - maxSimilarity;
        }

        // 0.35 relevance, 0.25 priority, 0.15 trust, 0.15 freshness, 0.10 novelty
        const score =
          0.35 * block.relevance +
          0.25 * block.priority +
          0.15 * block.trust +
          0.15 * block.freshness +
          0.10 * novelty;

        if (score > bestScore) {
          bestScore = score;
          bestBlock = block;
        }
      }

      if (!bestBlock) {
        break;
      }

      bestIndexInRemaining = remaining.findIndex(b => b.id === bestBlock!.id);
      if (bestIndexInRemaining === -1) {
        break;
      }

      const blockTokens = bestBlock.tokenCount ?? this.tokenizer(bestBlock.content);

      if (usedTokens + blockTokens <= totalBudget) {
        selected.push({
          ...bestBlock,
          tokenCount: blockTokens,
        });
        usedTokens += blockTokens;
        pathCounts[bestBlock.path] = (pathCounts[bestBlock.path] || 0) + 1;
        remaining.splice(bestIndexInRemaining, 1);
      } else {
        const remainingBudget = totalBudget - usedTokens;
        // Verify we can fit the basic truncation sign first
        const signTokens = this.tokenizer("\n... [Truncated] ...");
        if (remainingBudget <= signTokens) {
          break;
        }

        const truncatedContent = truncateBlockContent(
          bestBlock.content,
          bestBlock.path,
          remainingBudget,
          this.tokenizer,
          bestBlock.type
        );

        const truncatedTokens = this.tokenizer(truncatedContent);
        if (truncatedTokens <= remainingBudget && truncatedTokens > 0) {
          selected.push({
            ...bestBlock,
            content: truncatedContent,
            tokenCount: truncatedTokens,
          });
          usedTokens += truncatedTokens;
          pathCounts[bestBlock.path] = (pathCounts[bestBlock.path] || 0) + 1;
        }
        break;
      }
    }

    return selected;
  }
}
