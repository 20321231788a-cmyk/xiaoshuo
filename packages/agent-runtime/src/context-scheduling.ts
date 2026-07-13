import { ContextScheduler, type ContextBlock as ScheduledContextBlock } from "./context-scheduler.js";
import type { ContextBlock } from "./kernel/context-block.js";

/**
 * Applies the P4 token-aware selector before the legacy assembler enforces its
 * final character budget. Keeping the final assembler preserves the off-path
 * behavior and its existing trace contract.
 */
export function scheduleModelContextBlocks(blocks: ContextBlock[], enabled: boolean, compact: boolean): ContextBlock[] {
  if (!enabled) {
    return blocks;
  }

  const sourceBlocks = new Map(blocks.map((block) => [block.id, block]));
  const scheduler = new ContextScheduler({
    modelContextLimit: compact ? 8_000 : 16_000,
    toolDefinitionsMargin: compact ? 1_000 : 2_000,
    systemReserve: compact ? 1_000 : 2_000
  });
  const candidates: ScheduledContextBlock[] = blocks.map((block) => ({
    id: block.id,
    path: `${block.source}/${block.id}`,
    content: block.content,
    type: block.source,
    relevance: contextPriorityScore(block.priority),
    priority: contextPriorityScore(block.priority),
    trust: block.source === "web" || block.source === "attachment" || block.source === "document" ? 0.5 : 1,
    freshness: 1,
    allowInstruction: block.source === "runtime" || block.source === "conversation"
  }));

  return scheduler
    .schedule(candidates)
    .map((candidate) => {
      const source = sourceBlocks.get(candidate.id);
      return source ? { ...source, content: candidate.content } : null;
    })
    .filter((block): block is ContextBlock => Boolean(block));
}

function contextPriorityScore(priority: ContextBlock["priority"]): number {
  switch (priority) {
    case "critical":
      return 1;
    case "high":
      return 0.8;
    case "medium":
      return 0.55;
    default:
      return 0.3;
  }
}
