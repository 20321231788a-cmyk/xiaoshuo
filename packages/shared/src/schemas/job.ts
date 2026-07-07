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
