import { z } from "zod";

import { jobInfoSchema } from "./job.js";

export const skillModelPolicySchema = z
  .object({
    line: z.enum(["primary", "secondary", "auto"]).default("primary"),
    temperature: z.number().optional(),
    max_input_chars: z.number().optional()
  })
  .passthrough();

export const skillSavePolicySchema = z
  .object({
    default_mode: z.enum(["replace", "append"]).default("replace"),
    auto_commit: z.boolean().default(false),
    requires_confirmation: z.boolean().default(true)
  })
  .passthrough();

export const skillManifestSchema = z
  .object({
    id: z.string(),
    version: z.string().default("1.0.0"),
    name: z.string(),
    description: z.string(),
    handler_type: z.enum(["prompt", "workflow", "job", "external"]),
    input_mode: z.string().default("text"),
    input_schema: z.record(z.unknown()).default({}),
    output_schema: z.record(z.unknown()).default({}),
    context_requirements: z.array(z.string()).default([]),
    linked_targets: z.array(z.string()).default([]),
    tools: z.array(z.string()).default([]),
    model_policy: skillModelPolicySchema.default({}),
    save_policy: skillSavePolicySchema.default({}),
    eval_cases: z.array(z.string()).default([])
  })
  .passthrough();

export const skillDefinitionSchema = z
  .object({
    id: z.string(),
    version: z.string().optional(),
    name: z.string(),
    description: z.string(),
    input_mode: z.string(),
    input_schema: z.record(z.unknown()).optional(),
    output_schema: z.record(z.unknown()).optional(),
    context_requirements: z.array(z.string()),
    handler_type: z.enum(["prompt", "workflow", "job", "external"]),
    linked_targets: z.array(z.string()).default([]),
    tools: z.array(z.string()).optional(),
    model_policy: skillModelPolicySchema.optional(),
    save_policy: skillSavePolicySchema.optional(),
    eval_cases: z.array(z.string()).optional(),
    manifest: skillManifestSchema.optional(),
    prompt: z.string().default(""),
    imported_from: z.string().default(""),
    writable: z.boolean().default(false),
    builtin: z.boolean().optional(),
    disabled: z.boolean().optional()
  })
  .passthrough();

export const skillImportRequestSchema = z
  .object({
    path: z.string().trim().min(1)
  })
  .passthrough();

export const skillUpdateRequestSchema = z
  .object({
    description: z.string().max(1000).default("")
  })
  .passthrough();

export const skillDraftSourceKindSchema = z.enum([
  "instruction",
  "current_document",
  "selection",
  "attachment",
  "url",
  "markdown",
  "existing_skill"
]);

export const skillDraftRequestSchema = z
  .object({
    kind: skillDraftSourceKindSchema.default("instruction"),
    instruction: z.string().max(12000).default(""),
    text: z.string().max(120000).default(""),
    url: z.string().max(2000).default(""),
    current_path: z.string().default(""),
    selection: z.string().default(""),
    attachment_ids: z.array(z.string()).default([]),
    source_skill_id: z.string().default(""),
    target_name: z.string().max(100).default(""),
    target_id: z.string().max(100).default("")
  })
  .passthrough();

export const skillDraftFromUrlRequestSchema = z
  .object({
    url: z.string().trim().max(2000).default(""),
    instruction: z.string().max(4000).default("")
  })
  .passthrough();

export const skillDraftResponseSchema = z
  .object({
    skill: skillDefinitionSchema,
    source_url: z.string().default(""),
    source_name: z.string().default(""),
    source_excerpt: z.string().default(""),
    source_text: z.string().default(""),
    warnings: z.array(z.string()).default([])
  })
  .passthrough();

export const skillPatchRequestSchema = z
  .object({
    description: z.string().max(1000).optional(),
    prompt: z.string().max(120000).optional(),
    context_requirements: z.array(z.string()).optional(),
    linked_targets: z.array(z.string()).optional(),
    model_policy: skillModelPolicySchema.optional(),
    save_policy: skillSavePolicySchema.optional(),
    writable: z.boolean().optional(),
    change_reason: z.string().max(2000).default(""),
    expected_version: z.string().default(""),
    dry_run: z.boolean().default(false)
  })
  .passthrough();

export const skillPatchResponseSchema = z
  .object({
    skill: skillDefinitionSchema,
    previous_skill: skillDefinitionSchema.optional(),
    diff: z.string().default(""),
    version_id: z.string().default(""),
    dry_run: z.boolean().default(false),
    warnings: z.array(z.string()).default([])
  })
  .passthrough();

export const skillCloneRequestSchema = z
  .object({
    target_id: z.string().max(100).default(""),
    target_name: z.string().max(100).default(""),
    instruction: z.string().max(4000).default("")
  })
  .passthrough();

export const skillVersionEntrySchema = z
  .object({
    version_id: z.string(),
    skill_id: z.string(),
    created_at: z.string(),
    change_reason: z.string().default(""),
    author: z.string().default("agent"),
    snapshot: skillDefinitionSchema
  })
  .passthrough();

export const skillVersionsResponseSchema = z
  .object({
    skill_id: z.string(),
    versions: z.array(skillVersionEntrySchema).default([])
  })
  .passthrough();

export const skillRollbackRequestSchema = z
  .object({
    version_id: z.string(),
    change_reason: z.string().max(2000).default("rollback")
  })
  .passthrough();

export const skillImportDraftRequestSchema = z
  .object({
    skill: skillDefinitionSchema,
    source_url: z.string().default(""),
    source_name: z.string().default(""),
    source_text: z.string().max(120000).default("")
  })
  .passthrough();

export const skillOpenFolderResponseSchema = z
  .object({
    ok: z.boolean().default(true),
    path: z.string()
  })
  .passthrough();

export const skillRunRequestSchema = z
  .object({
    text: z.string().default(""),
    chapter: z.number().int().min(0).default(0),
    end_chapter: z.number().int().min(0).default(0),
    target_words: z.number().int().min(300).max(20000).default(2500),
    instruction: z.string().default(""),
    target_path: z.string().default(""),
    conversation_id: z.string().default(""),
    source_path: z.string().default(""),
    write_result: z.boolean().default(false),
    attachment_ids: z.array(z.string()).default([]),
    reference_paths: z.array(z.string()).default([]),
    confirmed_reference_paths: z.array(z.string()).default([]),
    disable_auto_references: z.boolean().default(false)
  })
  .passthrough();

export const skillRunResponseSchema = z
  .object({
    status: z.enum(["done", "job_created"]).default("done"),
    result: z.string().default(""),
    saved_path: z.string().default(""),
    data: z.record(z.unknown()).default({}),
    job: jobInfoSchema.optional(),
    ok: z.boolean().optional(),
    content: z.string().optional()
  })
  .passthrough();

export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;
export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type SkillModelPolicy = z.infer<typeof skillModelPolicySchema>;
export type SkillSavePolicy = z.infer<typeof skillSavePolicySchema>;
export type SkillImportRequest = z.infer<typeof skillImportRequestSchema>;
export type SkillUpdateRequest = z.infer<typeof skillUpdateRequestSchema>;
export type SkillDraftSourceKind = z.infer<typeof skillDraftSourceKindSchema>;
export type SkillDraftRequest = z.infer<typeof skillDraftRequestSchema>;
export type SkillDraftFromUrlRequest = z.infer<typeof skillDraftFromUrlRequestSchema>;
export type SkillDraftResponse = z.infer<typeof skillDraftResponseSchema>;
export type SkillPatchRequest = z.infer<typeof skillPatchRequestSchema>;
export type SkillPatchResponse = z.infer<typeof skillPatchResponseSchema>;
export type SkillCloneRequest = z.infer<typeof skillCloneRequestSchema>;
export type SkillVersionEntry = z.infer<typeof skillVersionEntrySchema>;
export type SkillVersionsResponse = z.infer<typeof skillVersionsResponseSchema>;
export type SkillRollbackRequest = z.infer<typeof skillRollbackRequestSchema>;
export type SkillImportDraftRequest = z.infer<typeof skillImportDraftRequestSchema>;
export type SkillOpenFolderResponse = z.infer<typeof skillOpenFolderResponseSchema>;
export type SkillRunRequest = z.infer<typeof skillRunRequestSchema>;
export type SkillRunResponse = z.infer<typeof skillRunResponseSchema>;

export const cardDrawRequestSchema = z
  .object({
    mode: z.enum(["outline", "detail_outline", "chapter_outline", "body"]),
    instruction: z.string().max(12000).default(""),
    chapter: z.number().int().min(1).default(1),
    start_chapter: z.number().int().min(1).default(1),
    chapter_count: z.number().int().min(1).max(300).default(1),
    section_words: z.number().int().min(100).max(2000).default(300),
    target_words: z.number().int().min(300).max(20000).default(2500),
    target_path: z.string().default(""),
    source_path: z.string().default(""),
    text: z.string().max(30000).default(""),
    candidate_count: z.number().int().min(2).max(5).default(5)
  })
  .passthrough();

export const cardDrawSelectRequestSchema = z
  .object({
    candidate_id: z.string().min(1).max(80),
    target_path: z.string().default("")
  })
  .passthrough();

export type CardDrawRequest = z.infer<typeof cardDrawRequestSchema>;
export type CardDrawSelectRequest = z.infer<typeof cardDrawSelectRequestSchema>;
