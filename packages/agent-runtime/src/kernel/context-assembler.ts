import type { AssembledContext, AssembledContextBlock, ContextBlock, ContextBlockPriority } from "./context-block.js";

export type ContextAssemblyMode = "chat" | "compact_retry" | "prompt_skill" | "body_generate" | "consistency_check";

const DEFAULT_CONTEXT_BUDGETS: Record<ContextAssemblyMode, number> = {
  chat: 36_000,
  compact_retry: 14_000,
  prompt_skill: 26_000,
  body_generate: 50_000,
  consistency_check: 45_000
};

const PRIORITY_ORDER: ContextBlockPriority[] = ["critical", "high", "medium", "low"];
const PRIORITY_RANK: Record<ContextBlockPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};

export type AssembleContextOptions = {
  mode?: ContextAssemblyMode;
  budget?: number;
  separator?: string;
};

type MutableAssembledBlock = AssembledContextBlock & {
  content: string;
  cappedChars: number;
};

export function getContextBudget(mode: ContextAssemblyMode): number {
  return DEFAULT_CONTEXT_BUDGETS[mode];
}

export function assembleContext(blocks: ContextBlock[], options: AssembleContextOptions = {}): AssembledContext {
  const totalBudget = Math.max(0, Math.trunc(options.budget ?? DEFAULT_CONTEXT_BUDGETS[options.mode ?? "chat"]));
  const separator = options.separator ?? "\n\n";
  const assembled = blocks.map(toMutableBlock);
  let remaining = totalBudget;

  for (const priority of PRIORITY_ORDER) {
    for (const block of assembled) {
      if (block.priority !== priority) {
        continue;
      }
      if (priority === "low" && block.cappedChars > remaining) {
        continue;
      }
      const includedChars = Math.min(block.cappedChars, Math.max(0, remaining));
      block.included = priority === "critical" || includedChars > 0;
      block.includedChars = includedChars;
      remaining -= includedChars;
    }
  }

  trimToBudget(assembled, separator, totalBudget);
  const visibleBlocks = assembled.filter((block) => block.included && block.includedChars > 0);
  const text = visibleBlocks.map((block) => block.content.slice(0, block.includedChars)).join(separator);
  const resultBlocks = assembled.map(({ content: _content, cappedChars: _cappedChars, ...block }) => block);

  return {
    text,
    blocks: resultBlocks,
    totalBudget,
    usedChars: text.length,
    truncated: resultBlocks.some((block, index) => block.includedChars < assembled[index]!.cappedChars)
  };
}

function toMutableBlock(block: ContextBlock): MutableAssembledBlock {
  const content = String(block.content || "");
  const originalChars = content.length;
  const cappedChars = Math.min(originalChars, Math.max(0, Math.trunc(block.maxChars ?? originalChars)));
  return {
    id: block.id,
    title: block.title,
    source: block.source,
    priority: block.priority,
    originalChars,
    includedChars: 0,
    included: false,
    ...(block.metadata ? { metadata: block.metadata } : {}),
    content,
    cappedChars
  };
}

function trimToBudget(blocks: MutableAssembledBlock[], separator: string, budget: number): void {
  while (currentTextLength(blocks, separator) > budget) {
    const victim = [...blocks]
      .filter((block) => block.included && block.includedChars > 0)
      .sort((left, right) => PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority])
      .at(0);
    if (!victim) {
      break;
    }
    const overflow = currentTextLength(blocks, separator) - budget;
    victim.includedChars = Math.max(0, victim.includedChars - overflow);
    if (victim.includedChars === 0 && victim.priority !== "critical") {
      victim.included = false;
    }
  }
}

function currentTextLength(blocks: MutableAssembledBlock[], separator: string): number {
  const included = blocks.filter((block) => block.included && block.includedChars > 0);
  if (!included.length) {
    return 0;
  }
  return included.reduce((total, block) => total + block.includedChars, 0) + separator.length * (included.length - 1);
}
