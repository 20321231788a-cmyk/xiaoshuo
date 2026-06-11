import { z } from "zod";

import { jobInfoSchema } from "./job.js";
export const skillDefinitionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    input_mode: z.string(),
    context_requirements: z.array(z.string()),
    handler_type: z.enum(["prompt", "workflow", "job", "external"]),
    linked_targets: z.array(z.string()).default([]),
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
    attachment_ids: z.array(z.string()).default([])
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
export type SkillImportRequest = z.infer<typeof skillImportRequestSchema>;
export type SkillDraftFromUrlRequest = z.infer<typeof skillDraftFromUrlRequestSchema>;
export type SkillDraftResponse = z.infer<typeof skillDraftResponseSchema>;
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
