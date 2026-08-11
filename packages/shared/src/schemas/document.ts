import { z } from "zod";

export type TreeNode = {
  path: string;
  name: string;
  kind: "directory" | "file";
  size: number;
  updated_at: string;
  children: TreeNode[];
};

export const documentInfoSchema = z
  .object({
    path: z.string(),
    name: z.string(),
    group: z.string(),
    size: z.number().int(),
    updated_at: z.string()
  })
  .passthrough();

export const treeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z
    .object({
      path: z.string(),
      name: z.string(),
      kind: z.enum(["directory", "file"]),
      size: z.number(),
      updated_at: z.string(),
      children: z.array(treeNodeSchema)
    })
    .passthrough()
);

export const documentContentSchema = z
  .object({
    path: z.string(),
    content: z.string(),
    updated_at: z.string(),
    updated_at_ms: z.number().optional(),
    changed: z.boolean().optional()
  })
  .passthrough();

export const saveDocumentRequestSchema = z
  .object({
    content: z.string().default(""),
    base_updated_at: z.string().optional(),
    base_updated_at_ms: z.number().optional(),
    force: z.boolean().default(false)
  })
  .passthrough();

export const libraryCardSchema = z
  .object({
    key: z.string(),
    title: z.string(),
    group: z.string(),
    path: z.string(),
    exists: z.boolean(),
    chars: z.number().int(),
    summary: z.string(),
    updated_at: z.string()
  })
  .passthrough();

export const revisionLogEntrySchema = z
  .object({
    id: z.string().optional(),
    timestamp: z.string().optional(),
    path: z.string().optional(),
    score: z.number().nullable().optional(),
    risks: z.array(z.string()).default([]),
    excerpt: z.string().default(""),
    raw: z.string().optional()
  })
  .passthrough();

export type DocumentContent = z.infer<typeof documentContentSchema>;
export type DocumentInfo = z.infer<typeof documentInfoSchema>;
export type LibraryCard = z.infer<typeof libraryCardSchema>;
export type RevisionLogEntry = z.infer<typeof revisionLogEntrySchema>;
export type SaveDocumentRequest = z.infer<typeof saveDocumentRequestSchema>;
