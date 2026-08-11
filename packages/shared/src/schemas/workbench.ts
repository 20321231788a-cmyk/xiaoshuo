import { z } from "zod";

export const ledgerItemSchema = z
  .object({
    id: z.string(),
    desc: z.string(),
    status: z.enum(["open", "closed"]),
    created_at: z.string(),
    updated_at: z.string()
  })
  .passthrough();

export const contextPreviewItemSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["当前文档", "选中段落", "固定文档", "固定段落", "资料卡", "提到文件", "项目摘要", "附件"]),
    label: z.string(),
    detail: z.string(),
    path: z.string().optional()
  })
  .passthrough();

export const cardDrawCandidateSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    chars: z.number().int(),
    excerpt: z.string()
  })
  .passthrough();

export const cardDrawResultSchema = z
  .object({
    draw_id: z.string(),
    mode: z.enum(["outline", "detail_outline", "chapter_outline", "body"]),
    target_path: z.string(),
    start_chapter: z.number().int().optional(),
    chapter_count: z.number().int().optional(),
    section_words: z.number().int().optional(),
    candidates: z.array(cardDrawCandidateSchema),
    selected_id: z.string().optional(),
    selected_path: z.string().optional(),
    archived_paths: z.array(z.string()).optional()
  })
  .passthrough();

export type LedgerItem = z.infer<typeof ledgerItemSchema>;
export type ContextPreviewItem = z.infer<typeof contextPreviewItemSchema>;
export type CardDrawCandidate = z.infer<typeof cardDrawCandidateSchema>;
export type CardDrawResult = z.infer<typeof cardDrawResultSchema>;
