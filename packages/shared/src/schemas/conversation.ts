import { z } from "zod";

export const conversationAttachmentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    media_type: z.string(),
    relative_path: z.string(),
    text_relative_path: z.string(),
    size: z.number(),
    excerpt: z.string(),
    created_at: z.string()
  })
  .passthrough();

export const pinnedContextItemSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["document", "selection", "text"]),
    label: z.string(),
    path: z.string(),
    content_excerpt: z.string(),
    created_at: z.string()
  })
  .passthrough();

export const conversationMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
    created_at: z.string(),
    metadata: z.record(z.unknown())
  })
  .passthrough();

export const conversationSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    current_skill: z.string(),
    current_agent: z.string(),
    message_count: z.number().int(),
    attachment_count: z.number().int()
  })
  .passthrough();

export const conversationDetailSchema = conversationSummarySchema
  .extend({
    summary: z.string(),
    pinned_context: z.array(pinnedContextItemSchema),
    attachments: z.array(conversationAttachmentSchema),
    messages: z.array(conversationMessageSchema)
  })
  .passthrough();

export type ConversationAttachment = z.infer<typeof conversationAttachmentSchema>;
export type PinnedContextItem = z.infer<typeof pinnedContextItemSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

export const conversationMessageRequestSchema = z
  .object({
    content: z.string().default(""),
    skill_id: z.string().default(""),
    agent_name: z.string().default(""),
    write_target: z.string().default(""),
    insert_mode: z.enum(["none", "append", "replace"]).default("none"),
    confirm_write: z.boolean().optional(),
    current_path: z.string().optional(),
    runtime_context: z.string().default(""),
    attachment_ids: z.array(z.string()).default([])
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.write_target.trim() && value.insert_mode === "none") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["insert_mode"],
        message: "write_target requires insert_mode to be append or replace"
      });
    }
  });

export type ConversationMessageRequest = z.infer<typeof conversationMessageRequestSchema>;
