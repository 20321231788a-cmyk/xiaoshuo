import { z } from "zod";
import { conversationDetailSchema } from "./conversation.js";
import { jobInfoSchema } from "./job.js";
import { skillRunResponseSchema } from "./skill.js";

export const fileOperationSchema = z
  .object({
    action: z.enum(["create_file", "append_text", "replace_text", "move_file", "archive_file"]),
    path: z.string(),
    text: z.string(),
    old_text: z.string(),
    new_text: z.string(),
    target_path: z.string(),
    reason: z.string(),
    requires_confirmation: z.boolean()
  })
  .passthrough();

export const agentPlanRequestSchema = z
  .object({
    instruction: z.string().default(""),
    current_path: z.string().default(""),
    selection: z.string().default(""),
    project_context_hint: z.string().default("")
  })
  .passthrough();

export const agentPlanResponseSchema = z
  .object({
    operations: z.array(fileOperationSchema),
    summary: z.string(),
    warnings: z.array(z.string()),
    can_execute: z.boolean()
  })
  .passthrough();

export const operationResultSchema = z
  .object({
    action: z.string(),
    path: z.string(),
    ok: z.boolean(),
    message: z.string()
  })
  .passthrough();

export const executePlanResponseSchema = z.array(operationResultSchema);

export const webSearchSourceSchema = z
  .object({
    title: z.string(),
    url: z.string()
  })
  .passthrough();

export const agentIntentSchema = z.enum(["file_operation", "read_context", "skill", "chat"]);

export const skillPlanStepSchema = z
  .object({
    skill_id: z.string().default(""),
    name: z.string().default(""),
    instruction: z.string().default(""),
    text: z.string().default(""),
    reason: z.string().default(""),
    confidence: z.number().min(0).max(1).default(0)
  })
  .passthrough();

export const skillPlanSchema = z
  .object({
    should_call_skill: z.boolean().default(false),
    steps: z.array(skillPlanStepSchema).default([]),
    selected_reason: z.string().default(""),
    confidence: z.number().min(0).max(1).default(0)
  })
  .passthrough();

export const projectFileReferenceKindSchema = z.enum([
  "explicit_path",
  "at_path",
  "alias",
  "current_document",
  "selection",
  "attachment",
  "manifest_match",
  "vector_hint"
]);

export const projectFileReferenceCandidateSchema = z
  .object({
    label: z.string().default(""),
    path: z.string().default(""),
    kind: projectFileReferenceKindSchema,
    confidence: z.number().min(0).max(1).default(0),
    reason: z.string().default(""),
    matched_text: z.string().default(""),
    exists: z.boolean().default(false),
    readable: z.boolean().default(false),
    chars: z.number().int().min(0).default(0),
    updated_at: z.string().default("")
  })
  .passthrough();

export const projectFileResolveRequestSchema = z
  .object({
    text: z.string().default(""),
    current_path: z.string().default(""),
    selection: z.string().default(""),
    attachment_ids: z.array(z.string()).default([]),
    explicit_paths: z.array(z.string()).default([]),
    max_candidates: z.number().int().min(1).max(20).default(8)
  })
  .passthrough();

export const projectFileResolveResponseSchema = z
  .object({
    references: z.array(projectFileReferenceCandidateSchema).default([]),
    candidates: z.array(projectFileReferenceCandidateSchema).default([]),
    ambiguous: z.boolean().default(false),
    warnings: z.array(z.string()).default([])
  })
  .passthrough();

export const projectFileReadRequestSchema = z
  .object({
    paths: z.array(z.string()).default([]),
    max_chars_per_file: z.number().int().min(500).max(50000).default(12000),
    max_total_chars: z.number().int().min(1000).max(120000).default(36000)
  })
  .passthrough();

export const projectFileReadBlockSchema = z
  .object({
    path: z.string(),
    title: z.string().default(""),
    content: z.string().default(""),
    chars: z.number().int().min(0).default(0),
    truncated: z.boolean().default(false)
  })
  .passthrough();

export const projectFileReadResponseSchema = z
  .object({
    blocks: z.array(projectFileReadBlockSchema).default([]),
    warnings: z.array(z.string()).default([])
  })
  .passthrough();

export const agentTraceStageSchema = z.enum([
  "received",
  "classified",
  "planned",
  "context_assembled",
  "model_started",
  "model_completed",
  "workflow_started",
  "workflow_completed",
  "save_planned",
  "save_committed",
  "conversation_recorded",
  "failed"
]);

export const agentRouteCandidateTraceSchema = z
  .object({
    skill_id: z.string().default(""),
    score: z.number().default(0),
    reasons: z.array(z.string()).default([]),
    signals: z.array(z.string()).default([])
  })
  .passthrough();

export const agentContextBlockTraceSchema = z
  .object({
    name: z.string(),
    source: z.enum(["project", "conversation", "document", "selection", "attachment", "pinned", "vector", "graph", "web", "runtime", "other"]),
    chars: z.number().int().min(0),
    included: z.boolean(),
    reason: z.string().default(""),
    metadata: z.record(z.unknown()).optional()
  })
  .passthrough();

export const agentModelCallTraceSchema = z
  .object({
    line: z.enum(["primary", "secondary", "primary-fallback", "unknown"]).default("unknown"),
    model: z.string().default(""),
    streaming: z.boolean().default(false),
    temperature: z.number().optional(),
    input_chars: z.number().int().min(0).default(0),
    output_chars: z.number().int().min(0).default(0),
    duration_ms: z.number().int().min(0).default(0),
    fallback_used: z.boolean().default(false),
    error: z.string().default("")
  })
  .passthrough();

export const agentSaveDecisionTraceSchema = z
  .object({
    action: z.string().default(""),
    mode: z.enum(["replace", "append"]).optional(),
    target_paths: z.array(z.string()).default([]),
    cache_id: z.string().default(""),
    auto_committed: z.boolean().default(false),
    reason: z.string().default("")
  })
  .passthrough();

export const agentRunTraceSchema = z
  .object({
    run_id: z.string(),
    request_id: z.string().default(""),
    conversation_id: z.string().default(""),
    skill_id: z.string().default(""),
    project_path: z.string().default(""),
    started_at: z.string(),
    ended_at: z.string().default(""),
    duration_ms: z.number().int().min(0).default(0),
    stage: agentTraceStageSchema.default("received"),
    intent: agentIntentSchema.optional(),
    input_excerpt: z.string().default(""),
    route_candidates: z.array(agentRouteCandidateTraceSchema).default([]),
    selected_skill_id: z.string().default(""),
    selected_reason: z.string().default(""),
    context_blocks: z.array(agentContextBlockTraceSchema).default([]),
    model_calls: z.array(agentModelCallTraceSchema).default([]),
    save_decision: agentSaveDecisionTraceSchema.optional(),
    saved_paths: z.array(z.string()).default([]),
    web_search_sources: z.array(webSearchSourceSchema).default([]),
    cancelled: z.boolean().default(false),
    error: z.string().default("")
  })
  .passthrough();

export const agentRunRequestSchema = z
  .object({
    conversation_id: z.string().default(""),
    content: z.string().default(""),
    current_path: z.string().default(""),
    selection: z.string().default(""),
    project_context_hint: z.string().default(""),
    skill_id: z.string().default(""),
    attachment_ids: z.array(z.string()).default([]),
    reference_paths: z.array(z.string()).default([]),
    confirmed_reference_paths: z.array(z.string()).default([]),
    disable_auto_references: z.boolean().default(false)
  })
  .passthrough();

export const agentRunResponseSchema = z
  .object({
    intent: agentIntentSchema,
    reply: z.string(),
    conversation: conversationDetailSchema.nullable().optional(),
    plan: agentPlanResponseSchema.nullable().optional(),
    results: z.array(operationResultSchema),
    skill_result: skillRunResponseSchema.nullable().optional(),
    saved_paths: z.array(z.string()),
    requires_confirmation: z.boolean(),
    web_search_sources: z.array(webSearchSourceSchema).optional(),
    current_skill: z.string().optional(),
    skill_steps: z.array(skillPlanStepSchema).optional(),
    skill_plan: skillPlanSchema.optional(),
    selected_reason: z.string().optional(),
    confidence: z.number().min(0).max(1).optional()
  })
  .passthrough();

export const generatedSaveSegmentSchema = z
  .object({
    target_path: z.string().default(""),
    content: z.string().default(""),
    mode: z.enum(["replace", "append"]).default("replace"),
    reason: z.string().default("")
  })
  .passthrough();

export const generatedSavePlanSchema = z
  .object({
    action: z.enum(["no_save", "save_generated", "split_and_save", "append_to_existing", "replace_existing", "create_file"]).default("no_save"),
    mode: z.enum(["replace", "append"]).default("replace"),
    target_paths: z.array(z.string()).default([]),
    segments: z.array(generatedSaveSegmentSchema).default([]),
    reason: z.string().default(""),
    confidence: z.number().min(0).max(1).default(0),
    requires_confirmation: z.boolean().default(true),
    should_auto_commit: z.boolean().default(false),
    source: z.string().default(""),
    skill_id: z.string().default("")
  })
  .passthrough();

export const generatedSaveResponseSchema = z
  .object({
    saved_paths: z.array(z.string()).default([]),
    save_plan: generatedSavePlanSchema.optional()
  })
  .passthrough();

export const generatedSaveRequestSchema = z
  .object({
    cache_id: z.string().default(""),
    content: z.string().default(""),
    skill_id: z.string().default(""),
    mode: z.enum(["replace", "append"]).default("replace"),
    target_paths: z.array(z.string()).default([]),
    target_path: z.string().default(""),
    chapter: z.number().default(0),
    save_plan: generatedSavePlanSchema.optional()
  })
  .passthrough();

export const generatedCacheMetaSchema = z
  .object({
    cache_id: z.string(),
    status: z.enum(["pending", "committed", "discarded", "failed"]),
    source: z.string().default(""),
    skill_id: z.string().default(""),
    mode: z.enum(["replace", "append"]).default("replace"),
    conversation_id: z.string().default(""),
    summary: z.string().default(""),
    target_paths: z.array(z.string()).default([]),
    cache_path: z.string().default(""),
    chars: z.number().default(0),
    created_at: z.string(),
    updated_at: z.string(),
    committed_at: z.string().default(""),
    discarded_at: z.string().default(""),
    failed_at: z.string().default(""),
    saved_paths: z.array(z.string()).default([]),
    error: z.string().default(""),
    transient: z.boolean().default(false),
    save_plan: generatedSavePlanSchema.optional()
  })
  .passthrough();

export const generatedCacheDetailSchema = z
  .object({
    meta: generatedCacheMetaSchema,
    content: z.string().default("")
  })
  .passthrough();

export const agentStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    intent: agentIntentSchema,
    conversation_id: z.string(),
    skill_id: z.string().optional().default(""),
    current_skill: z.string().optional(),
    skill_steps: z.array(skillPlanStepSchema).optional(),
    skill_plan: skillPlanSchema.optional(),
    selected_reason: z.string().optional(),
    confidence: z.number().min(0).max(1).optional()
  }),
  z.object({
    type: z.literal("delta"),
    text: z.string(),
    stage: z.string().optional(),
    skill_id: z.string().optional(),
    cache_id: z.string().optional(),
    target_paths: z.array(z.string()).optional(),
    append_mode: z.enum(["replace", "append"]).optional()
  }),
  z.object({
    type: z.literal("final"),
    payload: agentRunResponseSchema
  }),
  z.object({
    type: z.literal("error"),
    message: z.string()
  })
]);

export const skillRunResponseWithJobSchema = skillRunResponseSchema.extend({
  job: jobInfoSchema.optional()
});

export type FileOperation = z.infer<typeof fileOperationSchema>;
export type AgentPlanRequest = z.infer<typeof agentPlanRequestSchema>;
export type AgentPlanResponse = z.infer<typeof agentPlanResponseSchema>;
export type OperationResult = z.infer<typeof operationResultSchema>;
export type WebSearchSource = z.infer<typeof webSearchSourceSchema>;
export type ExecutePlanResponse = z.infer<typeof executePlanResponseSchema>;
export type AgentIntent = z.infer<typeof agentIntentSchema>;
export type SkillPlanStep = z.infer<typeof skillPlanStepSchema>;
export type SkillPlan = z.infer<typeof skillPlanSchema>;
export type ProjectFileReferenceKind = z.infer<typeof projectFileReferenceKindSchema>;
export type ProjectFileReferenceCandidate = z.infer<typeof projectFileReferenceCandidateSchema>;
export type ProjectFileResolveRequest = z.infer<typeof projectFileResolveRequestSchema>;
export type ProjectFileResolveResponse = z.infer<typeof projectFileResolveResponseSchema>;
export type ProjectFileReadRequest = z.infer<typeof projectFileReadRequestSchema>;
export type ProjectFileReadBlock = z.infer<typeof projectFileReadBlockSchema>;
export type ProjectFileReadResponse = z.infer<typeof projectFileReadResponseSchema>;
export type AgentTraceStage = z.infer<typeof agentTraceStageSchema>;
export type AgentRouteCandidateTrace = z.infer<typeof agentRouteCandidateTraceSchema>;
export type AgentContextBlockTrace = z.infer<typeof agentContextBlockTraceSchema>;
export type AgentModelCallTrace = z.infer<typeof agentModelCallTraceSchema>;
export type AgentSaveDecisionTrace = z.infer<typeof agentSaveDecisionTraceSchema>;
export type AgentRunTrace = z.infer<typeof agentRunTraceSchema>;
export type AgentRunRequest = {
  conversation_id: string;
  content: string;
  current_path: string;
  selection: string;
  project_context_hint: string;
  skill_id: string;
  attachment_ids: string[];
  reference_paths?: string[];
  confirmed_reference_paths?: string[];
  disable_auto_references?: boolean;
  [key: string]: unknown;
};
export type AgentRunResponse = z.infer<typeof agentRunResponseSchema>;
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;
export type SkillRunResponseWithJob = z.infer<typeof skillRunResponseWithJobSchema>;
export type GeneratedSaveResponse = z.infer<typeof generatedSaveResponseSchema>;
export type GeneratedSaveSegment = z.infer<typeof generatedSaveSegmentSchema>;
export type GeneratedSavePlan = z.infer<typeof generatedSavePlanSchema>;
export type GeneratedCacheMeta = z.infer<typeof generatedCacheMetaSchema>;
export type GeneratedCacheDetail = z.infer<typeof generatedCacheDetailSchema>;
export type GeneratedSaveRequest = z.infer<typeof generatedSaveRequestSchema>;
