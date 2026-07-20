import { z } from "zod";

export const reviewDimensionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  score: z.number().int().min(0).max(100).nullable().default(null)
});

export const reviewIssueStatusSchema = z.enum(["pending", "accepted", "ignored"]);

export const reviewIssueSchema = z.object({
  id: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(180),
  detail: z.string().trim().max(8000).default(""),
  source_path: z.string().trim().max(1000).default(""),
  excerpt: z.string().trim().max(4000).default(""),
  status: reviewIssueStatusSchema.default("pending"),
  created_at: z.string(),
  updated_at: z.string()
});

export const reviewReportSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().trim().min(1).max(120),
  version: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
  scope: z.enum(["chapter", "project"]),
  source_paths: z.array(z.string().trim().min(1).max(1000)).max(500).default([]),
  summary: z.string().trim().max(12000).default(""),
  dimensions: z.array(reviewDimensionSchema).max(20).default([]),
  issues: z.array(reviewIssueSchema).max(100).default([])
});

export const reviewReportsBundleSchema = z.object({
  schema_version: z.literal(1),
  revision: z.number().int().nonnegative(),
  reports: z.array(reviewReportSchema).default([])
});

export const createReviewReportRequestSchema = z.object({
  base_revision: z.number().int().nonnegative(),
  scope: z.enum(["chapter", "project"]),
  source_paths: z.array(z.string().trim().min(1).max(1000)).max(500).default([]),
  summary: z.string().trim().max(12000).default(""),
  dimensions: z.array(reviewDimensionSchema).max(20).default([]),
  issues: z.array(z.object({
    title: z.string().trim().min(1).max(180),
    detail: z.string().trim().max(8000).default(""),
    source_path: z.string().trim().max(1000).default(""),
    excerpt: z.string().trim().max(4000).default("")
  })).max(100).default([])
});

export const updateReviewIssueRequestSchema = z.object({
  base_revision: z.number().int().nonnegative(),
  status: reviewIssueStatusSchema
});

export type ReviewDimension = z.infer<typeof reviewDimensionSchema>;
export type ReviewIssue = z.infer<typeof reviewIssueSchema>;
export type ReviewIssueStatus = z.infer<typeof reviewIssueStatusSchema>;
export type ReviewReport = z.infer<typeof reviewReportSchema>;
export type ReviewReportsBundle = z.infer<typeof reviewReportsBundleSchema>;
export type CreateReviewReportRequest = z.infer<typeof createReviewReportRequestSchema>;
export type UpdateReviewIssueRequest = z.infer<typeof updateReviewIssueRequestSchema>;
