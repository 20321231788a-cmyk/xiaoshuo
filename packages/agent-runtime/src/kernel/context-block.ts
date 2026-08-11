export type ContextBlockPriority = "critical" | "high" | "medium" | "low";

export type ContextBlockSource =
  | "project"
  | "conversation"
  | "document"
  | "selection"
  | "attachment"
  | "pinned"
  | "vector"
  | "graph"
  | "web"
  | "runtime";

export type ContextBlock = {
  id: string;
  title: string;
  source: ContextBlockSource;
  priority: ContextBlockPriority;
  content: string;
  maxChars?: number;
  metadata?: Record<string, unknown>;
};

export type AssembledContextBlock = {
  id: string;
  title: string;
  source: ContextBlockSource;
  priority: ContextBlockPriority;
  originalChars: number;
  includedChars: number;
  included: boolean;
  metadata?: Record<string, unknown>;
};

export type AssembledContext = {
  text: string;
  blocks: AssembledContextBlock[];
  totalBudget: number;
  usedChars: number;
  truncated: boolean;
};
