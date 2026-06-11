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

export const agentRunRequestSchema = z
  .object({
    conversation_id: z.string().default(""),
    content: z.string().default(""),
    current_path: z.string().default(""),
    selection: z.string().default(""),
    project_context_hint: z.string().default(""),
    skill_id: z.string().default(""),
    attachment_ids: z.array(z.string()).default([])
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
    web_search_sources: z.array(webSearchSourceSchema).optional()
  })
  .passthrough();

export const generatedSaveResponseSchema = z
  .object({
    saved_paths: z.array(z.string()).default([])
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
    chapter: z.number().default(0)
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
    transient: z.boolean().default(false)
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
    skill_id: z.string().optional().default("")
  }),
  z.object({
    type: z.literal("delta"),
    text: z.string()
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
export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;
export type AgentRunResponse = z.infer<typeof agentRunResponseSchema>;
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;
export type SkillRunResponseWithJob = z.infer<typeof skillRunResponseWithJobSchema>;
export type GeneratedSaveResponse = z.infer<typeof generatedSaveResponseSchema>;
export type GeneratedCacheMeta = z.infer<typeof generatedCacheMetaSchema>;
export type GeneratedCacheDetail = z.infer<typeof generatedCacheDetailSchema>;
export type GeneratedSaveRequest = z.infer<typeof generatedSaveRequestSchema>;
