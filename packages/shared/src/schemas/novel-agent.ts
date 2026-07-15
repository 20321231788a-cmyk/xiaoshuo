import { z } from "zod";

export const novelAgentDomainSchema = z.literal("novel_creation");

export const novelUserGestureActionSchema = z.enum([
  "install_tool",
  "typed_action",
  "background_create",
  "background_control",
  "transfer_plan",
  "transfer_source_confirm",
  "transfer_target_confirm",
  "memory_batch"
]);

export const novelAgentRoleSchema = z.enum([
  "main_writer",
  "plot_reviewer",
  "character_reviewer",
  "continuity_reviewer",
  "style_reviewer"
]);

export const novelReviewRoleSchema = z.enum([
  "plot_reviewer",
  "character_reviewer",
  "continuity_reviewer",
  "style_reviewer"
]);

export const novelReviewSeveritySchema = z.enum(["info", "warning", "blocking"]);

export const novelEvidenceSchema = z.object({
  source_path: z.string().min(1),
  source_revision: z.string().min(1),
  excerpt: z.string().max(2_000).default(""),
  claim_id: z.string().default("")
}).strict();

export const novelReviewIssueSchema = z.object({
  issue_id: z.string().min(1),
  category: z.enum(["plot", "character", "continuity", "style"]),
  severity: novelReviewSeveritySchema,
  summary: z.string().min(1),
  suggestion: z.string().default(""),
  evidence: z.array(novelEvidenceSchema).max(12).default([]),
  requires_user_decision: z.boolean().default(false)
}).strict();

export const novelRoleReviewSchema = z.object({
  role: novelReviewRoleSchema,
  status: z.enum(["completed", "failed", "skipped"]),
  summary: z.string().default(""),
  issues: z.array(novelReviewIssueSchema).default([]),
  error_code: z.string().default(""),
  duration_ms: z.number().int().nonnegative().default(0)
}).strict();

export const novelRoomRequestSchema = z.object({
  domain: novelAgentDomainSchema.default("novel_creation"),
  project_id: z.string().min(1),
  run_id: z.string().min(1),
  budget_id: z.string().min(1),
  instruction: z.string().min(1),
  draft: z.string().default(""),
  current_path: z.string().default(""),
  source_revision: z.string().min(1),
  requested_roles: z.array(novelReviewRoleSchema).max(3).default([]),
  context_paths: z.array(z.string().min(1)).max(24).default([])
}).strict();

export const novelReviewConflictSchema = z.object({
  conflict_id: z.string().min(1),
  issue_ids: z.array(z.string().min(1)).min(2),
  summary: z.string().min(1),
  requires_user_decision: z.boolean().default(true)
}).strict();

export const novelRoomResponseSchema = z.object({
  domain: novelAgentDomainSchema,
  project_id: z.string().min(1),
  run_id: z.string().min(1),
  source_revision: z.string().min(1),
  reviews: z.array(novelRoleReviewSchema).max(3),
  conflicts: z.array(novelReviewConflictSchema).default([]),
  merged_summary: z.string().default(""),
  save_proposal_allowed: z.boolean(),
  degraded: z.boolean().default(false)
}).strict();

export const novelToolPermissionSchema = z.enum([
  "project_read",
  "project_write",
  "local_index",
  "document_convert"
]);

export const novelToolCatalogEntrySchema = z.object({
  tool_id: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string().min(1),
  description: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  compatible_app_versions: z.string().min(1),
  permissions: z.array(novelToolPermissionSchema).default([]),
  input_schema_id: z.string().min(1),
  output_schema_id: z.string().min(1),
  installer_id: z.string().min(1),
  uninstaller_id: z.string().min(1),
  rollback_version: z.string().default("")
}).strict();

export const novelToolInstallProposalSchema = z.object({
  proposal_id: z.string().min(1),
  project_id: z.string().min(1),
  run_id: z.string().min(1),
  budget_id: z.string().min(1),
  tool_id: z.string().min(1),
  version: z.string().min(1),
  reason: z.string().min(1),
  catalog_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["pending", "approved", "rejected", "installed", "failed"]),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime()
}).strict();

export const novelToolInstallProposalRequestSchema = z.object({
  project_id: z.string().min(1),
  project_root: z.string().min(1),
  run_id: z.string().min(1),
  budget_id: z.string().min(1),
  tool_id: z.string().min(1),
  version: z.string().min(1),
  reason: z.string().min(1).max(1_000)
}).strict();

export const novelToolInstallRequestSchema = z.object({
  proposal_id: z.string().min(1),
  expected_catalog_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation_id: z.string().min(1)
}).strict();

export const novelToolInstallResultSchema = z.object({
  proposal_id: z.string().min(1),
  tool_id: z.string().min(1),
  version: z.string().min(1),
  status: z.enum(["installed", "rejected", "failed"]),
  message: z.string().default("")
}).strict();

export const novelTypedActionSchema = z.enum([
  "backup_project",
  "export_project",
  "rebuild_index",
  "import_material",
  "convert_document",
  "open_project_folder"
]);

export const novelTypedActionRequestSchema = z.object({
  action: novelTypedActionSchema,
  project_id: z.string().min(1),
  project_root: z.string().min(1),
  format: z.enum(["txt", "md", "epub", "json"]).optional(),
  confirmation_id: z.string().min(1),
  operation_id: z.string().min(1)
}).strict();

export const novelTypedActionResultSchema = z.object({
  action: novelTypedActionSchema,
  operation_id: z.string().min(1),
  ok: z.boolean(),
  output_path: z.string().default(""),
  message: z.string().default("")
}).strict();

export const novelBackgroundTaskKindSchema = z.enum([
  "full_consistency_scan",
  "story_index_rebuild",
  "batch_chapter_quality",
  "material_summary",
  "approved_chapter_drafts"
]);

export const novelBackgroundTaskStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "paused_budget_exhausted",
  "completed",
  "failed",
  "cancelled"
]);

export const novelTaskBudgetSchema = z.object({
  budget_id: z.string().min(1),
  max_steps: z.number().int().positive().max(10_000),
  max_replans: z.number().int().nonnegative().max(100),
  max_model_calls: z.number().int().positive().max(10_000),
  max_input_tokens: z.number().int().positive(),
  max_output_tokens: z.number().int().positive(),
  max_cost_usd: z.number().nonnegative(),
  deadline_at: z.string().datetime(),
  max_retries: z.number().int().nonnegative().max(20)
}).strict();

export const novelBackgroundTaskCreateSchema = z.object({
  project_id: z.string().min(1),
  project_root: z.string().min(1),
  kind: novelBackgroundTaskKindSchema,
  input_revision: z.string().min(1),
  chapter_paths: z.array(z.string().min(1)).max(1_000).default([]),
  material_paths: z.array(z.string().min(1)).max(100).default([]),
  max_chapters: z.number().int().positive().max(1_000),
  budget: novelTaskBudgetSchema,
  confirmation_id: z.string().min(1)
}).strict();

export const novelBackgroundTaskSchema = novelBackgroundTaskCreateSchema.extend({
  task_id: z.string().min(1),
  status: novelBackgroundTaskStatusSchema,
  completed_units: z.number().int().nonnegative().default(0),
  total_units: z.number().int().nonnegative().default(0),
  used_steps: z.number().int().nonnegative().default(0),
  used_model_calls: z.number().int().nonnegative().default(0),
  used_input_tokens: z.number().int().nonnegative().default(0),
  used_output_tokens: z.number().int().nonnegative().default(0),
  used_cost_usd: z.number().nonnegative().default(0),
  error_code: z.string().default(""),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();

export const novelBackgroundTaskControlSchema = z.object({
  project_id: z.string().min(1),
  project_root: z.string().min(1),
  task_id: z.string().min(1),
  action: z.enum(["pause", "resume", "cancel"]),
  expected_status: novelBackgroundTaskStatusSchema,
  operation_id: z.string().min(1)
}).strict();

export const novelTransferItemKindSchema = z.enum([
  "character_setting",
  "world_setting",
  "style_rule",
  "reference_material"
]);

export const novelTransferItemSchema = z.object({
  item_id: z.string().min(1),
  kind: novelTransferItemKindSchema,
  source_path: z.string().min(1),
  source_revision: z.string().min(1),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  target_path: z.string().min(1),
  target_revision: z.string().default(""),
  target_sha256: z.string().default(""),
  strategy: z.enum(["create", "append", "replace", "skip"]),
  diff_preview: z.string().max(20_000).default("")
}).strict();

export const novelProjectTransferPlanSchema = z.object({
  transfer_id: z.string().min(1),
  plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_project_id: z.string().min(1),
  source_project_root: z.string().min(1),
  target_project_id: z.string().min(1),
  target_project_root: z.string().min(1),
  items: z.array(novelTransferItemSchema).min(1).max(200),
  status: z.enum(["draft", "awaiting_confirmation", "approved", "committing", "committed", "failed"]),
  expires_at: z.string().datetime()
}).strict();

export const novelProjectTransferPlanRequestSchema = z.object({
  source_project_id: z.string().min(1),
  source_project_root: z.string().min(1),
  target_project_id: z.string().min(1),
  target_project_root: z.string().min(1),
  items: z.array(z.object({
    kind: novelTransferItemKindSchema,
    source_path: z.string().min(1),
    target_path: z.string().min(1),
    strategy: z.enum(["create", "append", "replace", "skip"])
  }).strict()).min(1).max(200)
}).strict();

export const novelProjectTransferConfirmSchema = z.object({
  transfer_id: z.string().min(1),
  source_confirmation_id: z.string().min(1),
  target_confirmation_id: z.string().min(1),
  plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  operation_id: z.string().min(1)
}).strict();

export const novelProjectTransferSourceConfirmRequestSchema = z.object({
  transfer_id: z.string().min(1),
  plan_sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const novelProjectTransferSourceConfirmResultSchema = z.object({
  transfer_id: z.string().min(1),
  source_confirmation_id: z.string().min(1),
  expires_at: z.string().datetime()
}).strict();

export const novelProjectTransferCommitRequestSchema = z.object({
  transfer_id: z.string().min(1),
  source_confirmation_id: z.string().min(1),
  plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  operation_id: z.string().min(1)
}).strict();

export const novelProjectTransferResultSchema = z.object({
  transfer_id: z.string().min(1),
  status: z.enum(["committed", "failed"]),
  committed_items: z.number().int().nonnegative(),
  message: z.string().default("")
}).strict();

export const novelMemoryReviewItemSchema = z.object({
  claim_id: z.string().min(1),
  project_id: z.string().min(1),
  source_path: z.string().min(1),
  source_revision: z.string().min(1),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string().min(1),
  claim_type: z.string().min(1),
  perspective: z.string().default("objective"),
  story_time: z.string().default(""),
  subjective: z.boolean().default(false),
  conflict_summary: z.string().default("")
}).strict();

export const novelMemoryBatchReviewRequestSchema = z.object({
  project_id: z.string().min(1),
  batch_id: z.string().min(1),
  items: z.array(novelMemoryReviewItemSchema).min(1).max(100),
  confirmation_ids: z.record(z.string().min(1)),
  operation_id: z.string().min(1)
}).strict();

export const novelMemoryBatchReviewResultSchema = z.object({
  project_id: z.string().min(1),
  batch_id: z.string().min(1),
  confirmed_claim_ids: z.array(z.string()),
  rejected_claim_ids: z.array(z.string()),
  stale_claim_ids: z.array(z.string()),
  status: z.enum(["completed", "partial", "failed"])
}).strict();

export const novelWorkspaceProjectSchema = z.object({
  project_id: z.string().min(1),
  project_root: z.string().min(1)
}).strict();

export const novelProjectRootRequestSchema = z.object({
  project_root: z.string().min(1)
}).strict();

export const novelRoomDesktopRequestSchema = z.object({
  project_root: z.string().min(1),
  request: novelRoomRequestSchema
}).strict();

export const novelMemoryBatchPrepareResultSchema = z.object({
  project_id: z.string().min(1),
  items: z.array(novelMemoryReviewItemSchema),
  excluded_claim_ids: z.array(z.string()).default([])
}).strict();

export const novelMemoryBatchDesktopRequestSchema = z.object({
  project_root: z.string().min(1),
  request: novelMemoryBatchReviewRequestSchema
}).strict();

export const novelAgentWorkspaceSnapshotSchema = z.object({
  catalog_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  catalog: z.array(novelToolCatalogEntrySchema),
  tool_proposals: z.array(novelToolInstallProposalSchema),
  installed_tool_ids: z.array(z.string()),
  background_tasks: z.array(novelBackgroundTaskSchema),
  transfer_plans: z.array(novelProjectTransferPlanSchema)
}).strict();

export type NovelAgentRole = z.infer<typeof novelAgentRoleSchema>;
export type NovelUserGestureAction = z.infer<typeof novelUserGestureActionSchema>;
export type NovelReviewRole = z.infer<typeof novelReviewRoleSchema>;
export type NovelEvidence = z.infer<typeof novelEvidenceSchema>;
export type NovelReviewIssue = z.infer<typeof novelReviewIssueSchema>;
export type NovelRoleReview = z.infer<typeof novelRoleReviewSchema>;
export type NovelRoomRequest = z.infer<typeof novelRoomRequestSchema>;
export type NovelRoomResponse = z.infer<typeof novelRoomResponseSchema>;
export type NovelToolCatalogEntry = z.infer<typeof novelToolCatalogEntrySchema>;
export type NovelToolInstallProposal = z.infer<typeof novelToolInstallProposalSchema>;
export type NovelToolInstallProposalRequest = z.infer<typeof novelToolInstallProposalRequestSchema>;
export type NovelToolInstallRequest = z.infer<typeof novelToolInstallRequestSchema>;
export type NovelToolInstallResult = z.infer<typeof novelToolInstallResultSchema>;
export type NovelTypedAction = z.infer<typeof novelTypedActionSchema>;
export type NovelTypedActionRequest = z.infer<typeof novelTypedActionRequestSchema>;
export type NovelTypedActionResult = z.infer<typeof novelTypedActionResultSchema>;
export type NovelBackgroundTaskKind = z.infer<typeof novelBackgroundTaskKindSchema>;
export type NovelBackgroundTaskStatus = z.infer<typeof novelBackgroundTaskStatusSchema>;
export type NovelTaskBudget = z.infer<typeof novelTaskBudgetSchema>;
export type NovelBackgroundTaskCreate = z.infer<typeof novelBackgroundTaskCreateSchema>;
export type NovelBackgroundTask = z.infer<typeof novelBackgroundTaskSchema>;
export type NovelBackgroundTaskControl = z.infer<typeof novelBackgroundTaskControlSchema>;
export type NovelTransferItem = z.infer<typeof novelTransferItemSchema>;
export type NovelProjectTransferPlan = z.infer<typeof novelProjectTransferPlanSchema>;
export type NovelProjectTransferPlanRequest = z.infer<typeof novelProjectTransferPlanRequestSchema>;
export type NovelProjectTransferConfirm = z.infer<typeof novelProjectTransferConfirmSchema>;
export type NovelProjectTransferSourceConfirmRequest = z.infer<typeof novelProjectTransferSourceConfirmRequestSchema>;
export type NovelProjectTransferSourceConfirmResult = z.infer<typeof novelProjectTransferSourceConfirmResultSchema>;
export type NovelProjectTransferCommitRequest = z.infer<typeof novelProjectTransferCommitRequestSchema>;
export type NovelProjectTransferResult = z.infer<typeof novelProjectTransferResultSchema>;
export type NovelMemoryReviewItem = z.infer<typeof novelMemoryReviewItemSchema>;
export type NovelMemoryBatchReviewRequest = z.infer<typeof novelMemoryBatchReviewRequestSchema>;
export type NovelMemoryBatchReviewResult = z.infer<typeof novelMemoryBatchReviewResultSchema>;
export type NovelWorkspaceProject = z.infer<typeof novelWorkspaceProjectSchema>;
export type NovelProjectRootRequest = z.infer<typeof novelProjectRootRequestSchema>;
export type NovelRoomDesktopRequest = z.infer<typeof novelRoomDesktopRequestSchema>;
export type NovelMemoryBatchPrepareResult = z.infer<typeof novelMemoryBatchPrepareResultSchema>;
export type NovelMemoryBatchDesktopRequest = z.infer<typeof novelMemoryBatchDesktopRequestSchema>;
export type NovelAgentWorkspaceSnapshot = z.infer<typeof novelAgentWorkspaceSnapshotSchema>;
