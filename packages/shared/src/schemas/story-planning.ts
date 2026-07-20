import { z } from "zod";

const recordBaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(180),
  summary: z.string().default(""),
  order: z.number().int().nonnegative().default(0),
  chapter_paths: z.array(z.string().min(1)).default([]),
  entity_ids: z.array(z.string().min(1)).default([]),
  created_at: z.string(),
  updated_at: z.string()
});

export const storyOutlineNodeSchema = recordBaseSchema.extend({
  kind: z.enum(["main_arc", "character_arc", "volume", "chapter", "beat"]),
  parent_id: z.string().min(1).nullable().default(null),
  status: z.enum(["planned", "active", "done"]).default("planned")
});

export const storyTimelineEventSchema = recordBaseSchema.extend({
  story_time: z.string().trim().min(1).max(160),
  sort_key: z.string().trim().min(1).max(160),
  clue_ids: z.array(z.string().min(1)).default([]),
  status: z.enum(["planned", "occurred", "revealed"]).default("planned")
});

export const storyPlanningBundleSchema = z.object({
  schema_version: z.literal(1),
  revision: z.number().int().nonnegative(),
  updated_at: z.string(),
  outline: z.array(storyOutlineNodeSchema),
  timeline: z.array(storyTimelineEventSchema),
  projection_paths: z.array(z.string()).default([]),
  status: z.enum(["ready", "migration_required", "projection_drift"]).default("ready")
});

export const saveStoryPlanningRequestSchema = z.object({
  base_revision: z.number().int().nonnegative(),
  outline: z.array(storyOutlineNodeSchema),
  timeline: z.array(storyTimelineEventSchema)
});

export type StoryOutlineNode = z.infer<typeof storyOutlineNodeSchema>;
export type StoryTimelineEvent = z.infer<typeof storyTimelineEventSchema>;
export type StoryPlanningBundle = z.infer<typeof storyPlanningBundleSchema>;
export type SaveStoryPlanningRequest = z.infer<typeof saveStoryPlanningRequestSchema>;
