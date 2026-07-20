import { z } from "zod";

export const coverGenerationModeSchema = z.enum(["text_to_image", "image_to_image"]);

export const coverReferenceImageSchema = z.object({
  filename: z.string().trim().min(1).max(180),
  media_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  data_base64: z.string().min(1).max(14_000_000)
});

const coverTextField = (max: number) => z.string().trim().min(1).max(max).transform((value) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim());

export const coverGenerationRequestSchema = z.object({
  mode: coverGenerationModeSchema,
  book_title: coverTextField(80),
  author_name: coverTextField(40),
  font_style: coverTextField(80),
  genre_style: coverTextField(80),
  genre_description: z.string().max(1200).optional().default(""),
  genre_rules: z.array(z.string().trim().min(1).max(500)).max(12).optional().default([]),
  reference_image: coverReferenceImageSchema.optional()
}).superRefine((value, context) => {
  if (value.mode === "image_to_image" && !value.reference_image) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reference_image"], message: "图生图模式需要参考图片" });
  }
  if (value.mode === "text_to_image" && value.reference_image) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reference_image"], message: "文生图模式不接受参考图片" });
  }
});

export const coverRecordSchema = z.object({
  id: z.string().min(1),
  book_title: z.string(),
  author_name: z.string(),
  font_style: z.string(),
  genre_style: z.string(),
  mode: coverGenerationModeSchema,
  model: z.string(),
  provider: z.string().optional().default(""),
  original_path: z.string(),
  final_path: z.string(),
  original_media_type: z.string().default("image/png"),
  width: z.literal(600),
  height: z.literal(800),
  created_at: z.string()
});

export const coverHistoryResponseSchema = z.object({
  records: z.array(coverRecordSchema)
});

export const coverOpenFolderResponseSchema = z.object({
  ok: z.boolean(),
  path: z.string()
});

export type CoverGenerationMode = z.infer<typeof coverGenerationModeSchema>;
export type CoverReferenceImage = z.infer<typeof coverReferenceImageSchema>;
export type CoverGenerationRequest = z.infer<typeof coverGenerationRequestSchema>;
export type CoverRecord = z.infer<typeof coverRecordSchema>;
export type CoverHistoryResponse = z.infer<typeof coverHistoryResponseSchema>;
export type CoverOpenFolderResponse = z.infer<typeof coverOpenFolderResponseSchema>;
