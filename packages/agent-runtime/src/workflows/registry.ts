import { BatchGenerateWorkflow } from "./batch-generate.js";
import { BookFusionWorkflow } from "./book-fusion.js";
import { BodyGenerateWorkflow } from "./body-generate.js";
import { ConsistencyCheckWorkflow } from "./consistency-check.js";
import { ContinueDisassembleWorkflow } from "./continue-disassemble.js";
import { NuwaStyleDistillWorkflow } from "./nuwa-style-distill.js";
import { ScanPitsWorkflow } from "./scan-pits.js";
import type { WorkflowHandler } from "./types.js";

export const WORKFLOW_SKILL_IDS = [
  "disassemble_book",
  "continue_disassemble",
  "nuwa_style_distill",
  "scan_pits",
  "consistency_check",
  "body_generate",
  "batch_generate",
  "book_fusion"
] as const;

export type WorkflowSkillId = (typeof WORKFLOW_SKILL_IDS)[number];

const workflowSkillIds = new Set<string>(WORKFLOW_SKILL_IDS);
const workflowHandlers = new Map<string, WorkflowHandler>();

export function registerWorkflow(handler: WorkflowHandler): void {
  workflowHandlers.set(handler.id, handler);
}

export function getWorkflowHandler(skillId: string): WorkflowHandler | null {
  return workflowHandlers.get(skillId) || null;
}

export function isWorkflowSkillId(skillId: string): boolean {
  return workflowSkillIds.has(skillId);
}

const bodyGenerateWorkflow = new BodyGenerateWorkflow();

registerWorkflow(new ConsistencyCheckWorkflow());
registerWorkflow(bodyGenerateWorkflow);
registerWorkflow(new BatchGenerateWorkflow(bodyGenerateWorkflow));
registerWorkflow(new ScanPitsWorkflow());
registerWorkflow(new BookFusionWorkflow());
registerWorkflow(new NuwaStyleDistillWorkflow());
registerWorkflow(new ContinueDisassembleWorkflow());
