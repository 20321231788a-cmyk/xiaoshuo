import { z } from "zod";
import { conversationDetailSchema } from "./conversation.js";
import { jobInfoSchema } from "./job.js";
import { skillRunResponseSchema } from "./skill.js";

export const fileOperationSchema = z
  .object({
    action: z.enum(["create_file", "append_text", "replace_text", "move_file", "archive_file"]),
    path: z.string(),
    text: z.string(),
    old_text: z.string(),
    new_text: z.string(),
    target_path: z.string(),
    reason: z.string(),
    requires_confirmation: z.boolean()
  })
  .passthrough();

export const agentPlanRequestSchema = z
  .object({
    instruction: z.string().default(""),
    current_path: z.string().default(""),
    selection: z.string().default(""),
    project_context_hint: z.string().default("")
  })
  .passthrough();

export const agentPlanResponseSchema = z
  .object({
    operations: z.array(fileOperationSchema),
    summary: z.string(),
    warnings: z.array(z.string()),
    can_execute: z.boolean()
  })
  .passthrough();

export const operationResultSchema = z
  .object({
    action: z.string(),
    path: z.string(),
    ok: z.boolean(),
    message: z.string()
  })
  .passthrough();

export const executePlanResponseSchema = z.array(operationResultSchema);

export const webSearchSourceSchema = z
  .object({
    title: z.string(),
    url: z.string()
  })
  .passthrough();

export const agentIntentSchema = z.enum(["file_operation", "read_context", "skill", "chat"]);

export const skillPlanStepSchema = z
  .object({
    skill_id: z.string().default(""),
    name: z.string().default(""),
    instruction: z.string().default(""),
    text: z.string().default(""),
    reason: z.string().default(""),
    confidence: z.number().min(0).max(1).default(0)
  })
  .passthrough();

export const skillPlanSchema = z
  .object({
    should_call_skill: z.boolean().default(false),
    steps: z.array(skillPlanStepSchema).default([]),
    selected_reason: z.string().default(""),
    confidence: z.number().min(0).max(1).default(0)
  })
  .passthrough();

export const projectFileReferenceKindSchema = z.enum([
  "explicit_path",
  "at_path",
  "alias",
  "current_document",
  "selection",
  "attachment",
  "manifest_match",
  "vector_hint"
]);

export const projectFileReferenceCandidateSchema = z
  .object({
    label: z.string().default(""),
    path: z.string().default(""),
    kind: projectFileReferenceKindSchema,
    confidence: z.number().min(0).max(1).default(0),
    reason: z.string().default(""),
    matched_text: z.string().default(""),
    exists: z.boolean().default(false),
    readable: z.boolean().default(false),
    chars: z.number().int().min(0).default(0),
    updated_at: z.string().default("")
  })
  .passthrough();

export const projectFileResolveRequestSchema = z
  .object({
    text: z.string().default(""),
    current_path: z.string().default(""),
    selection: z.string().default(""),
    attachment_ids: z.array(z.string()).default([]),
    explicit_paths: z.array(z.string()).default([]),
    max_candidates: z.number().int().min(1).max(20).default(8)
  })
  .passthrough();

export const projectFileResolveResponseSchema = z
  .object({
    references: z.array(projectFileReferenceCandidateSchema).default([]),
    candidates: z.array(projectFileReferenceCandidateSchema).default([]),
    ambiguous: z.boolean().default(false),
    warnings: z.array(z.string()).default([])
  })
  .passthrough();

export const projectFileReadRequestSchema = z
  .object({
    paths: z.array(z.string()).default([]),
    max_chars_per_file: z.number().int().min(500).max(50000).default(12000),
    max_total_chars: z.number().int().min(1000).max(120000).default(36000)
  })
  .passthrough();

export const projectFileReadBlockSchema = z
  .object({
    path: z.string(),
    title: z.string().default(""),
    content: z.string().default(""),
    chars: z.number().int().min(0).default(0),
    truncated: z.boolean().default(false)
  })
  .passthrough();

export const projectFileReadResponseSchema = z
  .object({
    blocks: z.array(projectFileReadBlockSchema).default([]),
    warnings: z.array(z.string()).default([])
  })
  .passthrough();

export const agentTraceStageSchema = z.enum([
  "received",
  "classified",
  "planned",
  "context_assembled",
  "model_started",
  "model_completed",
  "workflow_started",
  "workflow_completed",
  "save_planned",
  "save_committed",
  "conversation_recorded",
  "failed"
]);

export const agentRouteCandidateTraceSchema = z
  .object({
    skill_id: z.string().default(""),
    score: z.number().default(0),
    reasons: z.array(z.string()).default([]),
    signals: z.array(z.string()).default([])
  })
  .passthrough();

export const agentContextBlockTraceSchema = z
  .object({
    name: z.string(),
    source: z.enum(["project", "conversation", "document", "selection", "attachment", "pinned", "vector", "graph", "web", "runtime", "other"]),
    chars: z.number().int().min(0),
    included: z.boolean(),
    reason: z.string().default(""),
    metadata: z.record(z.unknown()).optional()
  })
  .passthrough();

export const agentModelCallTraceSchema = z
  .object({
    line: z.enum(["primary", "secondary", "primary-fallback", "unknown"]).default("unknown"),
    model: z.string().default(""),
    streaming: z.boolean().default(false),
    temperature: z.number().optional(),
    input_chars: z.number().int().min(0).default(0),
    output_chars: z.number().int().min(0).default(0),
    duration_ms: z.number().int().min(0).default(0),
    fallback_used: z.boolean().default(false),
    error: z.string().default("")
  })
  .passthrough();

export const agentSaveDecisionTraceSchema = z
  .object({
    action: z.string().default(""),
    mode: z.enum(["replace", "append"]).optional(),
    target_paths: z.array(z.string()).default([]),
    cache_id: z.string().default(""),
    auto_committed: z.boolean().default(false),
    reason: z.string().default("")
  })
  .passthrough();

export const agentRunTraceSchema = z
  .object({
    run_id: z.string(),
    request_id: z.string().default(""),
    conversation_id: z.string().default(""),
    skill_id: z.string().default(""),
    project_path: z.string().default(""),
    started_at: z.string(),
    ended_at: z.string().default(""),
    duration_ms: z.number().int().min(0).default(0),
    stage: agentTraceStageSchema.default("received"),
    intent: agentIntentSchema.optional(),
    input_excerpt: z.string().default(""),
    route_candidates: z.array(agentRouteCandidateTraceSchema).default([]),
    selected_skill_id: z.string().default(""),
    selected_reason: z.string().default(""),
    context_blocks: z.array(agentContextBlockTraceSchema).default([]),
    model_calls: z.array(agentModelCallTraceSchema).default([]),
    save_decision: agentSaveDecisionTraceSchema.optional(),
    saved_paths: z.array(z.string()).default([]),
    web_search_sources: z.array(webSearchSourceSchema).default([]),
    cancelled: z.boolean().default(false),
    error: z.string().default("")
  })
  .passthrough();

export const intentAmbiguityImpactSchema = z.enum(["safe_assumption", "blocking"]);

export const intentAmbiguitySchema = z
  .object({
    code: z.string(),
    impact: intentAmbiguityImpactSchema,
    question: z.string()
  })
  .passthrough();

export const agentAllowedEffectSchema = z.enum(["suggest", "read", "draft", "network", "write"]);

export const agentProactiveLevelSchema = z.enum(["off", "quiet", "normal"]);

export const intentResolutionSchema = z
  .object({
    intent: z.string(),
    confidence: z.number().min(0).max(1).default(0),
    explicit_constraints: z.array(z.string()).default([]),
    ambiguities: z.array(intentAmbiguitySchema).default([]),
    allowed_effects: z.array(agentAllowedEffectSchema).default([]),
    proactive_level: agentProactiveLevelSchema.default("quiet")
  })
  .passthrough();

export const agentRunStatusSchema = z.enum([
  "queued",
  "planning",
  "running",
  "waiting_user_input",
  "cancelling",
  "waiting_confirmation",
  "paused",
  "failed",
  "cancelled",
  "completed"
]);

export const agentStepStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_confirmation",
  "done",
  "failed",
  "skipped",
  "cancelled"
]);

export const agentPlanStatusSchema = z.enum(["draft", "approved", "superseded"]);

export const agentExecutionStepTypeSchema = z.enum([
  "read",
  "skill",
  "workflow",
  "web_search",
  "verify",
  "save_preview",
  "chat",
  "file_operation"
]);

export const agentStepNecessitySchema = z.enum(["required", "optional"]);

export const agentStepAttemptStatusSchema = z.enum(["running", "interrupted", "done", "failed", "cancelled"]);

export const agentArtifactKindSchema = z.enum([
  "chat_answer",
  "generated_cache",
  "project_document",
  "quality_report",
  "memory_patch",
  "web_material"
]);

export const agentArtifactRefSchema = z
  .object({
    artifact_id: z.string(),
    kind: agentArtifactKindSchema,
    path: z.string().default(""),
    cache_id: z.string().default(""),
    content_hash: z.string().default(""),
    document_version: z.number().int().nonnegative().default(0),
    chars: z.number().int().nonnegative().default(0),
    created_by_step_id: z.string().default(""),
    created_by_attempt_id: z.string().default("")
  })
  .passthrough();

export const agentVerificationCheckSchema = z
  .object({
    code: z.string(),
    passed: z.boolean(),
    message: z.string().default(""),
    evidence_ref: z.string().default("")
  })
  .passthrough();

export const agentVerificationResultSchema = z
  .object({
    passed: z.boolean(),
    severity: z.enum(["none", "advice", "minor", "major", "blocking"]).default("none"),
    checks: z.array(agentVerificationCheckSchema).default([])
  })
  .passthrough();

export const agentExpectedOutputSchema = z
  .object({
    artifact_kind: agentArtifactKindSchema,
    allow_empty: z.boolean().default(false),
    format_schema: z.record(z.unknown()).default({}),
    target_path_pattern: z.string().default(""),
    minimum_checks: z.array(z.string()).default([])
  })
  .passthrough();

export const agentExecutionStepSchema = z
  .object({
    step_id: z.string(),
    version: z.number().int().positive().default(1),
    index: z.number().int().nonnegative(),
    type: agentExecutionStepTypeSchema,
    action_id: z.string(),
    skill_id: z.string().default(""),
    instruction: z.string().default(""),
    necessity: agentStepNecessitySchema.default("required"),
    input_refs: z.array(z.string()).default([]),
    required_permissions: z.array(z.string()).default([]),
    base_document_versions: z.record(z.number().int().nonnegative()).default({}),
    base_content_hashes: z.record(z.string()).default({}),
    idempotency_key: z.string(),
    expected_output: agentExpectedOutputSchema,
    status: agentStepStatusSchema.default("pending"),
    attempts: z.number().int().nonnegative().default(0),
    max_attempts: z.number().int().positive().default(2),
    retryable: z.boolean().default(false),
    requires_confirmation: z.boolean().default(false),
    observation_id: z.string().default(""),
    error_code: z.string().default(""),
    error: z.string().default(""),
    started_at: z.string().default(""),
    ended_at: z.string().default("")
  })
  .passthrough();

export const agentStepAttemptSchema = z
  .object({
    attempt_id: z.string(),
    run_id: z.string(),
    step_id: z.string(),
    attempt: z.number().int().positive(),
    status: agentStepAttemptStatusSchema.default("running"),
    input_digest: z.string().default(""),
    observation_id: z.string().default(""),
    idempotency_key: z.string(),
    model_call_refs: z.array(z.string()).default([]),
    error_code: z.string().default(""),
    error: z.string().default(""),
    started_at: z.string(),
    ended_at: z.string().default("")
  })
  .passthrough();

export const agentObservationSchema = z
  .object({
    observation_id: z.string(),
    run_id: z.string(),
    step_id: z.string(),
    attempt_id: z.string(),
    ok: z.boolean(),
    summary: z.string().default(""),
    output_refs: z.array(z.string()).default([]),
    saved_paths: z.array(z.string()).default([]),
    warnings: z.array(z.string()).default([]),
    verification: agentVerificationResultSchema,
    created_at: z.string()
  })
  .passthrough();

export const agentRunBudgetSchema = z
  .object({
    max_steps: z.number().int().positive().default(3),
    max_replans: z.number().int().nonnegative().default(1),
    max_attempts_per_step: z.number().int().positive().default(2),
    max_duration_ms: z.number().int().positive().default(300_000),
    max_input_tokens: z.number().int().nonnegative().default(32_000),
    max_output_tokens: z.number().int().nonnegative().default(8_000),
    max_cost: z.number().finite().nonnegative().default(1),
    cost_currency: z.literal("USD").default("USD"),
    pricing_snapshot_id: z.string().default(""),
    used_steps: z.number().int().nonnegative().default(0),
    used_replans: z.number().int().nonnegative().default(0),
    used_input_tokens: z.number().int().nonnegative().default(0),
    used_output_tokens: z.number().int().nonnegative().default(0),
    estimated_cost: z.number().finite().nonnegative().default(0)
  })
  .passthrough();

export const agentAutonomyModeSchema = z.enum(["assist", "plan", "execute"]);

export const agentExecutionV2ModeSchema = z.enum(["off", "shadow", "on"]);

export const DEFAULT_AGENT_FEATURE_FLAG_SNAPSHOT = {
  schema_version: 1,
  agent_execution_v2_mode: "off",
  model_gateway_v2: false,
  agent_replanning_v2: false,
  context_budget_v2: false,
  memory_v2: false,
  memory_context_selector_v2: false,
  quality_gate_v2: false,
  agent_event_stream_v2: false,
  agent_inline_plan_ui: false
} as const;

const agentFeatureFlagSnapshotV1Schema = z
  .object({
    schema_version: z.literal(1),
    agent_execution_v2_mode: agentExecutionV2ModeSchema,
    model_gateway_v2: z.boolean(),
    agent_replanning_v2: z.boolean(),
    context_budget_v2: z.boolean(),
    memory_v2: z.boolean(),
    memory_context_selector_v2: z.boolean(),
    quality_gate_v2: z.boolean(),
    agent_event_stream_v2: z.boolean(),
    agent_inline_plan_ui: z.boolean()
  })
  .strict();

export const agentFeatureFlagSnapshotSchema = z.preprocess(
  (value) => (isEmptyObject(value) ? undefined : value),
  agentFeatureFlagSnapshotV1Schema.default(DEFAULT_AGENT_FEATURE_FLAG_SNAPSHOT)
);

export const agentGoalRequestSnapshotSchema = z
  .object({
    content: z.string().default(""),
    attachment_refs: z.array(z.string()).default([]),
    selected_file_refs: z.array(z.string()).default([]),
    settings_snapshot: z.record(z.unknown()).default({}),
    feature_flag_snapshot: agentFeatureFlagSnapshotSchema
  });

export const agentGoalSchema = z
  .object({
    instruction: z.string().default(""),
    autonomy_mode: agentAutonomyModeSchema.default("plan"),
    requested_outputs: z.array(agentExpectedOutputSchema).default([]),
    success_criteria: z.array(z.string()).default([]),
    assumptions: z.array(z.string()).default([]),
    blocking_questions: z.array(z.string()).default([]),
    request_snapshot: agentGoalRequestSnapshotSchema.default({})
  })
  .passthrough();

export const agentConfirmationSchema = z
  .object({
    confirmation_id: z.string(),
    version: z.number().int().positive().default(1),
    run_id: z.string(),
    step_id: z.string(),
    action: z.string(),
    risk_level: z.enum(["low", "medium", "high", "critical"]),
    summary: z.string().default(""),
    target_paths: z.array(z.string()).default([]),
    expected_versions: z.record(z.number().int().nonnegative()).default({}),
    expected_hashes: z.record(z.string()).default({}),
    proposed_artifact_refs: z.array(z.string()).default([]),
    status: z.enum(["pending", "approved", "rejected", "expired", "superseded"]).default("pending"),
    expires_at: z.string().default(""),
    resolved_at: z.string().optional(),
    resolved_by: z.enum(["user", "policy"]).optional()
  })
  .passthrough();

export const agentRunEventSchema = z
  .object({
    event_id: z.string(),
    run_id: z.string(),
    sequence: z.number().int().positive(),
    event_type: z.string(),
    step_id: z.string().default(""),
    payload: z.record(z.unknown()).default({}),
    created_at: z.string()
  })
  .passthrough();

export const agentRunStateSchema = z
  .object({
    schema_version: z.number().int().positive().default(1),
    version: z.number().int().positive().default(1),
    run_id: z.string(),
    request_id: z.string().default(""),
    conversation_id: z.string().default(""),
    project_id: z.string().default(""),
    project_path: z.string().default(""),
    goal: agentGoalSchema,
    goal_revision: z.number().int().positive().default(1),
    plan_version: z.number().int().positive().default(1),
    plan_status: agentPlanStatusSchema.default("draft"),
    status: agentRunStatusSchema.default("queued"),
    current_step_id: z.string().default(""),
    runtime_instance_id: z.string().default(""),
    heartbeat_at: z.string().default(""),
    lease_expires_at: z.string().default(""),
    pause_requested_at: z.string().default(""),
    cancel_requested_at: z.string().default(""),
    recovery_reason: z.string().default(""),
    error_code: z.string().default(""),
    error: z.string().default(""),
    steps: z.array(agentExecutionStepSchema).default([]),
    artifacts: z.array(agentArtifactRefSchema).default([]),
    budget: agentRunBudgetSchema.default({}),
    last_event_sequence: z.number().int().nonnegative().default(0),
    created_at: z.string(),
    updated_at: z.string()
  })
  .passthrough();

export const agentRunListResponseSchema = z
  .object({
    runs: z.array(agentRunStateSchema),
    next_cursor: z.string().min(1).nullable()
  })
  .passthrough();

export const agentRunEventReplayResponseSchema = z
  .object({
    events: z.array(agentRunEventSchema),
    next_after: z.number().int().nonnegative(),
    next_sequence: z.number().int().nonnegative().default(0),
    has_more: z.boolean().default(false),
    earliest_available_sequence: z.number().int().nonnegative().default(0),
    gap_detected: z.boolean().default(false)
  })
  .passthrough();

export type AgentRunExport = {
  format_version: 1;
  exported_at: string;
  project_id: string;
  project_path: string;
  run: AgentRunState;
  steps: AgentExecutionStep[];
  attempts: AgentStepAttempt[];
  observations: AgentObservation[];
  artifacts: AgentArtifactRef[];
  confirmations: AgentConfirmation[];
  events: AgentRunEvent[];
  control_operations: Record<string, unknown>[];
  commit_journal: Record<string, unknown>[];
};

export type AgentRunDeleteResponse = {
  run_id: string;
  project_id: string;
  deleted_at: string;
  deleted_records: {
    run: 1;
    steps: number;
    attempts: number;
    observations: number;
    artifacts: number;
    confirmations: number;
    events: number;
    control_operations: number;
    commit_journal: number;
    write_leases: number;
  };
  preserved_artifacts: AgentArtifactRef[];
};

/** A portable, project-local record of one durable execution and its audit trail. */
export const agentRunExportSchema: z.ZodType<AgentRunExport> = z
  .object({
    format_version: z.literal(1),
    exported_at: z.string(),
    project_id: z.string(),
    project_path: z.string(),
    run: agentRunStateSchema,
    steps: z.array(agentExecutionStepSchema),
    attempts: z.array(agentStepAttemptSchema),
    observations: z.array(agentObservationSchema),
    artifacts: z.array(agentArtifactRefSchema),
    confirmations: z.array(agentConfirmationSchema),
    events: z.array(agentRunEventSchema),
    control_operations: z.array(z.record(z.unknown())).default([]),
    commit_journal: z.array(z.record(z.unknown())).default([])
  })
  .passthrough() as z.ZodType<AgentRunExport>;

export const agentRunDeleteResponseSchema: z.ZodType<AgentRunDeleteResponse> = z
  .object({
    run_id: z.string(),
    project_id: z.string(),
    deleted_at: z.string(),
    deleted_records: z.object({
      run: z.literal(1),
      steps: z.number().int().nonnegative(),
      attempts: z.number().int().nonnegative(),
      observations: z.number().int().nonnegative(),
      artifacts: z.number().int().nonnegative(),
      confirmations: z.number().int().nonnegative(),
      events: z.number().int().nonnegative(),
      control_operations: z.number().int().nonnegative(),
      commit_journal: z.number().int().nonnegative(),
      write_leases: z.number().int().nonnegative()
    }),
    // The record is removed, but these are references to project files/cache that
    // deletion must never unlink implicitly.
    preserved_artifacts: z.array(agentArtifactRefSchema).default([])
  })
  .passthrough() as z.ZodType<AgentRunDeleteResponse>;

export const agentRunControlRequestSchema = z
  .object({
    operation_id: z.string().trim().min(1),
    expected_version: z.number().int().positive()
  })
  .passthrough();

export const agentStepRetryRequestSchema = agentRunControlRequestSchema.extend({});

export const agentConfirmationResolveRequestSchema = agentRunControlRequestSchema.extend({});

export const agentRecoverableRequestSchema = z.object({
  request_id: z.string().default(""),
  autonomy_mode: agentAutonomyModeSchema.default("plan"),
  conversation_id: z.string().default(""),
  content: z.string().default(""),
  current_path: z.string().default(""),
  selection: z.string().default(""),
  project_context_hint: z.string().default(""),
  skill_id: z.string().default(""),
  attachment_ids: z.array(z.string()).default([]),
  reference_paths: z.array(z.string()).default([]),
  confirmed_reference_paths: z.array(z.string()).default([]),
  disable_auto_references: z.boolean().default(false),
  instruction: z.string().optional(),
  text: z.string().optional(),
  chapter: z.number().int().positive().optional(),
  start_chapter: z.number().int().positive().optional(),
  end_chapter: z.number().int().positive().optional(),
  chapter_count: z.number().int().positive().optional(),
  section_words: z.number().int().positive().optional(),
  target_words: z.number().int().positive().optional(),
  source_path: z.string().optional(),
  target_path: z.string().optional(),
  write_result: z.boolean().optional(),
  candidate_count: z.number().int().positive().optional(),
  mode: z.string().optional(),
  auto_revision: z.boolean().optional(),
  score_threshold: z.number().finite().optional(),
  book_title: z.string().optional(),
  source_book_id: z.string().optional(),
  source_book_ids: z.array(z.string()).optional(),
  custom_prompt: z.string().optional(),
  genre_hint: z.string().optional(),
  output_mode: z.string().optional(),
  action: z.string().optional(),
  skill_request_origin: z.string().optional(),
  conversation_write_target: z.string().optional(),
  conversation_write_mode: z.enum(["append", "replace"]).optional(),
  conversation_confirm_write: z.boolean().optional(),
  suppress_conversation_record: z.boolean().optional()
});

export const agentRunRequestSchema = z
  .object({
    request_id: z.string().default(""),
    autonomy_mode: agentAutonomyModeSchema.default("plan"),
    conversation_id: z.string().default(""),
    content: z.string().default(""),
    current_path: z.string().default(""),
    selection: z.string().default(""),
    project_context_hint: z.string().default(""),
    skill_id: z.string().default(""),
    attachment_ids: z.array(z.string()).default([]),
    reference_paths: z.array(z.string()).default([]),
    confirmed_reference_paths: z.array(z.string()).default([]),
    disable_auto_references: z.boolean().default(false)
  })
  .passthrough();

export const agentRunResponseSchema = z
  .object({
    run_id: z.string().optional(),
    intent: agentIntentSchema,
    reply: z.string(),
    conversation: conversationDetailSchema.nullable().optional(),
    plan: agentPlanResponseSchema.nullable().optional(),
    results: z.array(operationResultSchema),
    skill_result: skillRunResponseSchema.nullable().optional(),
    saved_paths: z.array(z.string()),
    requires_confirmation: z.boolean(),
    web_search_sources: z.array(webSearchSourceSchema).optional(),
    current_skill: z.string().optional(),
    skill_steps: z.array(skillPlanStepSchema).optional(),
    skill_plan: skillPlanSchema.optional(),
    selected_reason: z.string().optional(),
    confidence: z.number().min(0).max(1).optional()
  })
  .passthrough();

export const generatedSaveSegmentSchema = z
  .object({
    target_path: z.string().default(""),
    content: z.string().default(""),
    mode: z.enum(["replace", "append"]).default("replace"),
    reason: z.string().default("")
  })
  .passthrough();

export const generatedSavePlanSchema = z
  .object({
    action: z.enum(["no_save", "save_generated", "split_and_save", "append_to_existing", "replace_existing", "create_file"]).default("no_save"),
    mode: z.enum(["replace", "append"]).default("replace"),
    target_paths: z.array(z.string()).default([]),
    segments: z.array(generatedSaveSegmentSchema).default([]),
    reason: z.string().default(""),
    confidence: z.number().min(0).max(1).default(0),
    requires_confirmation: z.boolean().default(true),
    should_auto_commit: z.boolean().default(false),
    source: z.string().default(""),
    skill_id: z.string().default("")
  })
  .passthrough();

export const generatedSaveResponseSchema = z
  .object({
    saved_paths: z.array(z.string()).default([]),
    save_plan: generatedSavePlanSchema.optional()
  })
  .passthrough();

export const generatedSaveRequestSchema = z
  .object({
    cache_id: z.string().default(""),
    content: z.string().default(""),
    skill_id: z.string().default(""),
    mode: z.enum(["replace", "append"]).default("replace"),
    target_paths: z.array(z.string()).default([]),
    target_path: z.string().default(""),
    chapter: z.number().default(0),
    save_plan: generatedSavePlanSchema.optional()
  })
  .passthrough();

export const generatedCacheMetaSchema = z
  .object({
    cache_id: z.string(),
    status: z.enum(["pending", "committed", "discarded", "failed"]),
    source: z.string().default(""),
    skill_id: z.string().default(""),
    mode: z.enum(["replace", "append"]).default("replace"),
    conversation_id: z.string().default(""),
    summary: z.string().default(""),
    target_paths: z.array(z.string()).default([]),
    cache_path: z.string().default(""),
    chars: z.number().default(0),
    created_at: z.string(),
    updated_at: z.string(),
    committed_at: z.string().default(""),
    discarded_at: z.string().default(""),
    failed_at: z.string().default(""),
    saved_paths: z.array(z.string()).default([]),
    commit_run_id: z.string().default(""),
    commit_request_id: z.string().default(""),
    commit_journal_ids: z.array(z.string()).default([]),
    error: z.string().default(""),
    transient: z.boolean().default(false),
    save_plan: generatedSavePlanSchema.optional()
  })
  .passthrough();

export const generatedCacheDetailSchema = z
  .object({
    meta: generatedCacheMetaSchema,
    content: z.string().default("")
  })
  .passthrough();

export const agentStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    run_id: z.string().optional(),
    intent: agentIntentSchema,
    conversation_id: z.string(),
    skill_id: z.string().optional().default(""),
    current_skill: z.string().optional(),
    skill_steps: z.array(skillPlanStepSchema).optional(),
    skill_plan: skillPlanSchema.optional(),
    selected_reason: z.string().optional(),
    confidence: z.number().min(0).max(1).optional()
  }),
  z.object({
    type: z.literal("delta"),
    text: z.string(),
    stage: z.string().optional(),
    skill_id: z.string().optional(),
    cache_id: z.string().optional(),
    target_paths: z.array(z.string()).optional(),
    append_mode: z.enum(["replace", "append"]).optional()
  }),
  z.object({
    type: z.literal("final"),
    payload: agentRunResponseSchema
  }),
  z.object({
    type: z.literal("error"),
    run_id: z.string().optional(),
    error_code: z.string().optional(),
    message: z.string()
  })
]);

export const skillRunResponseWithJobSchema = skillRunResponseSchema.extend({
  job: jobInfoSchema.optional()
});

export type FileOperation = z.infer<typeof fileOperationSchema>;
export type AgentPlanRequest = z.infer<typeof agentPlanRequestSchema>;
export type AgentPlanResponse = z.infer<typeof agentPlanResponseSchema>;
export type OperationResult = z.infer<typeof operationResultSchema>;
export type WebSearchSource = z.infer<typeof webSearchSourceSchema>;
export type ExecutePlanResponse = z.infer<typeof executePlanResponseSchema>;
export type AgentIntent = z.infer<typeof agentIntentSchema>;
export type SkillPlanStep = z.infer<typeof skillPlanStepSchema>;
export type SkillPlan = z.infer<typeof skillPlanSchema>;
export type ProjectFileReferenceKind = z.infer<typeof projectFileReferenceKindSchema>;
export type ProjectFileReferenceCandidate = z.infer<typeof projectFileReferenceCandidateSchema>;
export type ProjectFileResolveRequest = z.infer<typeof projectFileResolveRequestSchema>;
export type ProjectFileResolveResponse = z.infer<typeof projectFileResolveResponseSchema>;
export type ProjectFileReadRequest = z.infer<typeof projectFileReadRequestSchema>;
export type ProjectFileReadBlock = z.infer<typeof projectFileReadBlockSchema>;
export type ProjectFileReadResponse = z.infer<typeof projectFileReadResponseSchema>;
export type AgentTraceStage = z.infer<typeof agentTraceStageSchema>;
export type AgentRouteCandidateTrace = z.infer<typeof agentRouteCandidateTraceSchema>;
export type AgentContextBlockTrace = z.infer<typeof agentContextBlockTraceSchema>;
export type AgentModelCallTrace = z.infer<typeof agentModelCallTraceSchema>;
export type AgentSaveDecisionTrace = z.infer<typeof agentSaveDecisionTraceSchema>;
export type AgentRunTrace = z.infer<typeof agentRunTraceSchema>;
export type IntentAmbiguityImpact = z.infer<typeof intentAmbiguityImpactSchema>;
export type IntentAmbiguity = z.infer<typeof intentAmbiguitySchema>;
export type AgentAllowedEffect = z.infer<typeof agentAllowedEffectSchema>;
export type AgentProactiveLevel = z.infer<typeof agentProactiveLevelSchema>;
export type IntentResolution = z.infer<typeof intentResolutionSchema>;
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;
export type AgentStepStatus = z.infer<typeof agentStepStatusSchema>;
export type AgentPlanStatus = z.infer<typeof agentPlanStatusSchema>;
export type AgentExecutionStepType = z.infer<typeof agentExecutionStepTypeSchema>;
export type AgentStepNecessity = z.infer<typeof agentStepNecessitySchema>;
export type AgentStepAttemptStatus = z.infer<typeof agentStepAttemptStatusSchema>;
export type AgentArtifactKind = z.infer<typeof agentArtifactKindSchema>;
export type AgentArtifactRef = z.infer<typeof agentArtifactRefSchema>;
export type AgentVerificationResult = z.infer<typeof agentVerificationResultSchema>;
export type AgentExpectedOutput = z.infer<typeof agentExpectedOutputSchema>;
export type AgentExecutionStep = z.infer<typeof agentExecutionStepSchema>;
export type AgentStepAttempt = z.infer<typeof agentStepAttemptSchema>;
export type AgentObservation = z.infer<typeof agentObservationSchema>;
export type AgentRunBudget = z.infer<typeof agentRunBudgetSchema>;
export type AgentAutonomyMode = z.infer<typeof agentAutonomyModeSchema>;
export type AgentExecutionV2Mode = z.infer<typeof agentExecutionV2ModeSchema>;
export type AgentFeatureFlagSnapshot = z.infer<typeof agentFeatureFlagSnapshotSchema>;
export type AgentGoalRequestSnapshot = z.infer<typeof agentGoalRequestSnapshotSchema>;
export type AgentGoal = z.infer<typeof agentGoalSchema>;
export type AgentConfirmation = z.infer<typeof agentConfirmationSchema>;
export type AgentRunEvent = z.infer<typeof agentRunEventSchema>;
export type AgentRunState = z.infer<typeof agentRunStateSchema>;
export type AgentRunListResponse = z.infer<typeof agentRunListResponseSchema>;
export type AgentRunEventReplayResponse = z.infer<typeof agentRunEventReplayResponseSchema>;
export type AgentRunControlRequest = z.infer<typeof agentRunControlRequestSchema>;
export type AgentStepRetryRequest = z.infer<typeof agentStepRetryRequestSchema>;
export type AgentConfirmationResolveRequest = z.infer<typeof agentConfirmationResolveRequestSchema>;
export type AgentRecoverableRequest = z.infer<typeof agentRecoverableRequestSchema>;
export type AgentRunRequest = {
  request_id?: string;
  autonomy_mode?: AgentAutonomyMode;
  conversation_id: string;
  content: string;
  current_path: string;
  selection: string;
  project_context_hint: string;
  skill_id: string;
  attachment_ids: string[];
  reference_paths?: string[];
  confirmed_reference_paths?: string[];
  disable_auto_references?: boolean;
  [key: string]: unknown;
};
export type AgentRunResponse = z.infer<typeof agentRunResponseSchema>;
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;
export type SkillRunResponseWithJob = z.infer<typeof skillRunResponseWithJobSchema>;
export type GeneratedSaveResponse = z.infer<typeof generatedSaveResponseSchema>;
export type GeneratedSaveSegment = z.infer<typeof generatedSaveSegmentSchema>;
export type GeneratedSavePlan = z.infer<typeof generatedSavePlanSchema>;
export type GeneratedCacheMeta = z.infer<typeof generatedCacheMetaSchema>;
export type GeneratedCacheDetail = z.infer<typeof generatedCacheDetailSchema>;
export type GeneratedSaveRequest = z.infer<typeof generatedSaveRequestSchema>;

function isEmptyObject(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}
