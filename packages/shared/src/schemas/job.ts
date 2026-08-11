import { z } from "zod";

export const jobStatusSchema = z.enum(["queued", "running", "done", "failed", "cancelled"]);

export const jobInfoSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    status: jobStatusSchema,
    progress: z.number(),
    message: z.string(),
    result: z.unknown().optional(),
    error: z.string().optional()
  })
  .passthrough();

export type JobStatus = z.infer<typeof jobStatusSchema>;
export type JobInfo = z.infer<typeof jobInfoSchema>;

/**
 * A read-only compatibility projection for work still owned by JobManager.
 *
 * `run_id` is deliberately namespaced and is not an Agent Execution Store id.
 * It is useful to a unified task list for correlation only; callers must use
 * the nested legacy job state and must not send Agent lifecycle controls to it.
 */
export const legacyJobRunMappingSchema = z
  .object({
    mapping_version: z.literal(1),
    source: z.literal("legacy_job_manager"),
    legacy_job_id: z.string().min(1),
    run_id: z.string().regex(/^legacy-job:/),
    job: jobInfoSchema,
    read_only: z.literal(true),
    recoverable: z.literal(false),
    agent_control_operations: z.tuple([])
  })
  .strict();

export const legacyJobRunMappingListResponseSchema = z
  .object({
    mappings: z.array(legacyJobRunMappingSchema)
  })
  .strict();

export type LegacyJobRunMapping = z.infer<typeof legacyJobRunMappingSchema>;
export type LegacyJobRunMappingListResponse = z.infer<typeof legacyJobRunMappingListResponseSchema>;

export const novelCrawlRequestSchema = z
  .object({
    query: z.string().default(""),
    source: z.string().default("auto"),
    start_chapter: z.number().int().min(1).default(1),
    max_chapters: z.number().int().min(1).default(30),
    min_chars: z.number().int().min(0).default(200000)
  })
  .passthrough();

export type NovelCrawlRequest = z.infer<typeof novelCrawlRequestSchema>;
