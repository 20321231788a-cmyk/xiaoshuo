import { z } from "zod";
import { libraryCardSchema, treeNodeSchema, documentContentSchema } from "./document.js";
import { fileOperationSchema } from "./agent.js";

export const currentProjectSchema = z
  .object({
    path: z.string(),
    name: z.string(),
    previous_path: z.string().optional()
  })
  .passthrough();

export const projectOpenRequestSchema = z
  .object({
    path: z.string().min(1),
    project_name: z.string().default(""),
    create_in_parent: z.boolean().default(false)
  })
  .passthrough();

export const projectPickerResponseSchema = z
  .object({
    path: z.string()
  })
  .passthrough();

export const projectRenameRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80)
  })
  .passthrough();

export const projectManifestStatusSchema = z
  .object({
    ready: z.boolean(),
    files: z.number().int(),
    version: z.number(),
    generated_at: z.string(),
    source: z.string(),
    path: z.string()
  })
  .passthrough();

export const vectorIndexStatusSchema = z
  .object({
    enabled: z.boolean(),
    configured: z.boolean(),
    db: z.string(),
    chunks: z.number().int(),
    embedded_chunks: z.number().int(),
    current_embedded_chunks: z.number().int(),
    pending_files: z.number().int(),
    embedding_model: z.string(),
    ready: z.boolean(),
    updated_at: z.string()
  })
  .passthrough();

export const vectorOperationResultSchema = vectorIndexStatusSchema
  .extend({
    files: z.number().int().optional(),
    changed_chunks: z.number().int().optional(),
    pending_before: z.number().int().optional(),
    processed_files: z.number().int().optional(),
    indexed_files: z.number().int().optional(),
    deleted_files: z.number().int().optional(),
    skipped_files: z.number().int().optional(),
    failed_files: z.array(z.object({ path: z.string(), error: z.string() })).optional()
  })
  .passthrough();

export const vectorSearchHitSchema = z
  .object({
    path: z.string(),
    source_type: z.string(),
    title: z.string(),
    text: z.string(),
    score: z.number()
  })
  .passthrough();

export const vectorSearchRequestSchema = z
  .object({
    query: z.string().trim().min(1),
    top_k: z.number().int().min(1).max(40).optional(),
    max_chars: z.number().int().min(100).max(80000).optional()
  })
  .passthrough();

export const vectorSearchResponseSchema = z
  .object({
    hits: z.array(vectorSearchHitSchema)
  })
  .passthrough();

export const timelineFileChangeSchema = z
  .object({
    path: z.string(),
    action: z.string(),
    before_exists: z.boolean(),
    before_content: z.string(),
    after_exists: z.boolean(),
    after_excerpt: z.string()
  })
  .passthrough();

export const timelineEntrySchema = z
  .object({
    id: z.string(),
    time: z.string(),
    source: z.string(),
    summary: z.string(),
    session_id: z.string().optional(),
    session_label: z.string().optional(),
    session_started_at: z.string().optional(),
    files: z.array(timelineFileChangeSchema),
    operations: z.array(fileOperationSchema),
    timestamp: z.string().optional(),
    action: z.string().optional(),
    title: z.string().optional(),
    path: z.string().optional()
  })
  .passthrough();

export const timelineRollbackResultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string(),
    entry: timelineEntrySchema.nullable(),
    requires_confirmation: z.boolean()
  })
  .passthrough();

export const timelineDeleteResultSchema = z
  .object({
    ok: z.boolean(),
    deleted_id: z.string()
  })
  .passthrough();

export const projectChromeSnapshotSchema = z
  .object({
    tree: z.array(treeNodeSchema),
    libraries: z.array(libraryCardSchema),
    timeline: z.array(timelineEntrySchema),
    current: currentProjectSchema,
    version: z.number(),
    generated_at: z.string()
  })
  .passthrough();

export type CurrentProject = z.infer<typeof currentProjectSchema>;
export type ProjectOpenRequest = z.infer<typeof projectOpenRequestSchema>;
export type ProjectPickerResponse = z.infer<typeof projectPickerResponseSchema>;
export type ProjectRenameRequest = z.infer<typeof projectRenameRequestSchema>;
export type ProjectManifestStatus = z.infer<typeof projectManifestStatusSchema>;
export type TimelineFileChange = z.infer<typeof timelineFileChangeSchema>;
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;
export type TimelineRollbackResult = z.infer<typeof timelineRollbackResultSchema>;
export type TimelineDeleteResult = z.infer<typeof timelineDeleteResultSchema>;
export type ProjectChromeSnapshot = z.infer<typeof projectChromeSnapshotSchema>;
export type VectorIndexStatus = z.infer<typeof vectorIndexStatusSchema>;
export type VectorOperationResult = z.infer<typeof vectorOperationResultSchema>;
export type VectorSearchHit = z.infer<typeof vectorSearchHitSchema>;
export type VectorSearchRequest = z.infer<typeof vectorSearchRequestSchema>;
export type VectorSearchResponse = z.infer<typeof vectorSearchResponseSchema>;

export const styleDistillationProfileSchema = z
  .object({
    book_title: z.string().default(""),
    source_summary: z.string().default(""),
    source_path: z.string().default(""),
    source_hash: z.string().default(""),
    distilled_at: z.string().default(""),
    enabled: z.boolean().default(false),
    profile_text: z.string().default("")
  })
  .passthrough();

export const continuityContextSchema = z
  .object({
    outline: z.string().default(""),
    detailed_outline: z.string().default(""),
    chapter_outline: z.string().default(""),
    previous_chapters: z.array(documentContentSchema).default([]),
    lore: z.record(z.string()).default({}),
    style: z.record(z.string()).default({}),
    genre: z.record(z.string()).default({}),
    state_summary: z.string().default(""),
    style_distillation: styleDistillationProfileSchema.nullable().default(null)
  })
  .passthrough();

export type StyleDistillationProfile = z.infer<typeof styleDistillationProfileSchema>;
export type ContinuityContext = z.infer<typeof continuityContextSchema>;
