import { z } from "zod";

export const projectLibraryDomainSchema = z.enum(["lore", "style", "genre"]);
export const projectLibraryRecordStatusSchema = z.enum(["active", "archived"]);
export const projectLibraryOriginSchema = z.enum(["manual", "legacy_import", "agent_draft", "transfer"]);

const libraryRecordBaseSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  name: z.string().trim().min(1).max(160),
  summary: z.string().default(""),
  tags: z.array(z.string().trim().min(1).max(60)).default([]),
  order: z.number().int().nonnegative().default(0),
  status: projectLibraryRecordStatusSchema.default("active"),
  origin: projectLibraryOriginSchema.default("manual"),
  created_at: z.string(),
  updated_at: z.string(),
  needs_review: z.boolean().default(false),
  notes: z.string().default("")
});

export const loreEntityKindSchema = z.enum(["character", "location", "faction", "item", "world_rule"]);

export const loreEntityRecordSchema = libraryRecordBaseSchema.extend({
  kind: loreEntityKindSchema,
  role: z.string().default(""),
  aliases: z.array(z.string()).default([]),
  age: z.string().default(""),
  identity: z.string().default(""),
  goal: z.string().default(""),
  fear: z.string().default(""),
  traits: z.array(z.string()).default([]),
  appearance: z.string().default(""),
  speech_style: z.string().default(""),
  constraints: z.array(z.string()).default([])
});

export const loreRelationRecordSchema = libraryRecordBaseSchema.extend({
  kind: z.literal("relation"),
  from_id: z.string().min(1),
  to_id: z.string().min(1),
  relation_type: z.string().trim().min(1).max(80),
  direction: z.enum(["directed", "undirected"]).default("undirected")
});

export const loreArcPointSchema = z.object({
  phase: z.enum(["start", "current", "turn", "end"]),
  text: z.string().default("")
});

export const loreArcRecordSchema = libraryRecordBaseSchema.extend({
  kind: z.literal("character_arc"),
  character_id: z.string().min(1),
  points: z.array(loreArcPointSchema).max(4).default([])
});

export const loreRecordSchema = z.discriminatedUnion("kind", [
  loreEntityRecordSchema,
  loreRelationRecordSchema,
  loreArcRecordSchema
]);

export const styleProfileRecordSchema = libraryRecordBaseSchema.extend({
  kind: z.literal("style_profile"),
  narrative_pov: z.string().default(""),
  description: z.string().default(""),
  active: z.boolean().default(true)
});

export const styleRuleRecordSchema = libraryRecordBaseSchema.extend({
  kind: z.literal("style_rule"),
  category: z.enum(["perspective", "pacing", "suspense", "emotion", "language", "custom"]).default("custom"),
  instruction: z.string().default(""),
  severity: z.enum(["hard", "preference"]).default("preference"),
  enabled: z.boolean().default(true)
});

export const languagePreferenceRecordSchema = libraryRecordBaseSchema.extend({
  kind: z.literal("language_preference"),
  preference: z.enum(["prefer", "avoid"]),
  replacement: z.string().default("")
});

export const styleExampleRecordSchema = libraryRecordBaseSchema.extend({
  kind: z.literal("style_example"),
  before: z.string().default(""),
  after: z.string().default(""),
  explanation: z.string().default(""),
  source_ref: z.string().default("")
});

export const styleMaterialRecordSchema = libraryRecordBaseSchema.extend({
  kind: z.literal("style_material"),
  content: z.string().default("")
});

export const styleRecordSchema = z.discriminatedUnion("kind", [
  styleProfileRecordSchema,
  styleRuleRecordSchema,
  languagePreferenceRecordSchema,
  styleExampleRecordSchema,
  styleMaterialRecordSchema
]);

export const genreProfileRecordSchema = libraryRecordBaseSchema.extend({
  kind: z.literal("genre_profile"),
  description: z.string().default(""),
  active: z.boolean().default(true)
});

export const genreRuleRecordSchema = libraryRecordBaseSchema.extend({
  kind: z.literal("genre_rule"),
  category: z.enum(["world", "terminology", "power", "technology", "system", "tone", "boundary", "custom"]).default("custom"),
  instruction: z.string().default(""),
  severity: z.enum(["hard", "preference"]).default("hard"),
  enabled: z.boolean().default(true)
});

export const genreMaterialRecordSchema = libraryRecordBaseSchema.extend({
  kind: z.literal("genre_material"),
  content: z.string().default("")
});

export const conflictTemplateRecordSchema = libraryRecordBaseSchema.extend({
  kind: z.literal("conflict_template"),
  setup: z.string().default(""),
  pressure: z.string().default(""),
  reversal: z.string().default(""),
  resolution: z.string().default("")
});

export const bannedExpressionRecordSchema = libraryRecordBaseSchema.extend({
  kind: z.literal("banned_expression"),
  replacement: z.string().default(""),
  reason: z.string().default("")
});

export const genreRecordSchema = z.discriminatedUnion("kind", [
  genreProfileRecordSchema,
  genreRuleRecordSchema,
  genreMaterialRecordSchema,
  conflictTemplateRecordSchema,
  bannedExpressionRecordSchema
]);

export const projectLibraryRecordSchema = z.union([loreRecordSchema, styleRecordSchema, genreRecordSchema]);

export const projectLibraryBundleSchema = z.object({
  schema_version: z.literal(1),
  domain: projectLibraryDomainSchema,
  revision: z.number().int().nonnegative(),
  updated_at: z.string(),
  records: z.array(projectLibraryRecordSchema),
  status: z.enum(["ready", "migration_required", "projection_drift"]).default("ready"),
  projection_paths: z.array(z.string()).default([]),
  migration_preview: z.object({
    records: z.array(projectLibraryRecordSchema),
    warnings: z.array(z.string()).default([])
  }).optional()
});

export const saveProjectLibraryRequestSchema = z.object({
  base_revision: z.number().int().nonnegative(),
  records: z.array(projectLibraryRecordSchema)
});

export const libraryMigrationRequestSchema = z.object({
  domains: z.array(projectLibraryDomainSchema).min(1),
  confirm: z.literal(true)
});

export const libraryReconcileRequestSchema = z.object({
  action: z.enum(["rebuild_projection", "reimport_projection"]),
  confirm: z.literal(true)
});

export type ProjectLibraryDomain = z.infer<typeof projectLibraryDomainSchema>;
export type ProjectLibraryRecord = z.infer<typeof projectLibraryRecordSchema>;
export type LoreRecord = z.infer<typeof loreRecordSchema>;
export type StyleRecord = z.infer<typeof styleRecordSchema>;
export type GenreRecord = z.infer<typeof genreRecordSchema>;
export type ProjectLibraryBundle = z.infer<typeof projectLibraryBundleSchema>;
export type SaveProjectLibraryRequest = z.infer<typeof saveProjectLibraryRequestSchema>;
