import { describe, expect, it } from "vitest";
import {
  agentArtifactRefSchema,
  agentConfirmationSchema,
  agentConfirmationResolveRequestSchema,
  agentExecutionStepSchema,
  agentExecutionStepTypeSchema,
  agentGoalSchema,
  agentObservationSchema,
  agentPlanStatusSchema,
  agentRunBudgetSchema,
  agentRunControlRequestSchema,
  agentRunEventReplayResponseSchema,
  agentRunEventSchema,
  agentRunListResponseSchema,
  agentRecoverableRequestSchema,
  agentRunRequestSchema,
  agentRunResponseSchema,
  agentRunStateSchema,
  agentRunStatusSchema,
  agentStepAttemptSchema,
  agentStepAttemptStatusSchema,
  agentStepRetryRequestSchema,
  agentStepStatusSchema,
  agentStreamEventSchema,
  intentResolutionSchema,
  projectFileReferenceCandidateSchema,
  projectFileReadRequestSchema,
  projectFileResolveRequestSchema
} from "./agent.js";

describe("agent schemas", () => {
  it("applies project file resolve defaults", () => {
    const parsed = projectFileResolveRequestSchema.parse({});

    expect(parsed).toMatchObject({
      text: "",
      current_path: "",
      selection: "",
      attachment_ids: [],
      explicit_paths: [],
      max_candidates: 8
    });
  });

  it("rejects project file confidence outside 0..1", () => {
    expect(() =>
      projectFileReferenceCandidateSchema.parse({
        kind: "alias",
        confidence: 1.01
      })
    ).toThrow();
  });

  it("enforces max candidate bounds", () => {
    expect(() => projectFileResolveRequestSchema.parse({ max_candidates: 21 })).toThrow();
    expect(projectFileResolveRequestSchema.parse({ max_candidates: 20 }).max_candidates).toBe(20);
  });

  it("keeps old agent run payloads compatible", () => {
    const parsed = agentRunRequestSchema.parse({
      content: "参考章纲继续写"
    });

    expect(parsed.request_id).toBe("");
    expect(parsed.autonomy_mode).toBe("plan");
    expect(parsed.reference_paths).toEqual([]);
    expect(parsed.confirmed_reference_paths).toEqual([]);
    expect(parsed.disable_auto_references).toBe(false);

    expect(agentRunRequestSchema.parse({ request_id: "request-1", autonomy_mode: "execute" })).toMatchObject({
      request_id: "request-1",
      autonomy_mode: "execute"
    });
    expect(() => agentRunRequestSchema.parse({ autonomy_mode: "unattended" })).toThrow();
  });

  it("keeps old agent run responses compatible and accepts an optional run id", () => {
    const response = {
      intent: "chat" as const,
      reply: "完成",
      results: [],
      saved_paths: [],
      requires_confirmation: false
    };

    expect(agentRunResponseSchema.parse(response)).not.toHaveProperty("run_id");
    expect(agentRunResponseSchema.parse({ ...response, run_id: "run-1" }).run_id).toBe("run-1");
  });

  it("accepts every run, step, attempt, plan, and step type enum value", () => {
    const runStatuses = [
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
    ];
    const stepStatuses = [
      "pending",
      "running",
      "waiting_confirmation",
      "done",
      "failed",
      "skipped",
      "cancelled"
    ];
    const attemptStatuses = ["running", "interrupted", "done", "failed", "cancelled"];
    const planStatuses = ["draft", "approved", "superseded"];
    const stepTypes = [
      "read",
      "skill",
      "workflow",
      "web_search",
      "verify",
      "save_preview",
      "chat",
      "file_operation"
    ];

    for (const status of runStatuses) {
      expect(agentRunStatusSchema.parse(status)).toBe(status);
    }
    for (const status of stepStatuses) {
      expect(agentStepStatusSchema.parse(status)).toBe(status);
    }
    for (const status of attemptStatuses) {
      expect(agentStepAttemptStatusSchema.parse(status)).toBe(status);
    }
    for (const status of planStatuses) {
      expect(agentPlanStatusSchema.parse(status)).toBe(status);
    }
    for (const type of stepTypes) {
      expect(agentExecutionStepTypeSchema.parse(type)).toBe(type);
    }
    expect(() => agentRunStatusSchema.parse("unknown")).toThrow();
    expect(() => agentStepStatusSchema.parse("paused")).toThrow();
    expect(() => agentStepAttemptStatusSchema.parse("pending")).toThrow();
    expect(() => agentPlanStatusSchema.parse("running")).toThrow();
    expect(() => agentExecutionStepTypeSchema.parse("shell")).toThrow();
  });

  it("parses auditable intent resolution and enforces its boundaries", () => {
    const resolution = intentResolutionSchema.parse({
      intent: "continue_chapter",
      ambiguities: [
        {
          code: "missing_target",
          impact: "blocking",
          question: "续写哪一章？"
        }
      ],
      allowed_effects: ["read", "draft"]
    });

    expect(resolution).toEqual({
      intent: "continue_chapter",
      confidence: 0,
      explicit_constraints: [],
      ambiguities: [
        {
          code: "missing_target",
          impact: "blocking",
          question: "续写哪一章？"
        }
      ],
      allowed_effects: ["read", "draft"],
      proactive_level: "quiet"
    });
    expect(() => intentResolutionSchema.parse({ intent: "chat", confidence: -0.01 })).toThrow();
    expect(() => intentResolutionSchema.parse({ intent: "chat", confidence: 1.01 })).toThrow();
    expect(() => intentResolutionSchema.parse({ intent: "chat", allowed_effects: ["execute"] })).toThrow();
    expect(() =>
      intentResolutionSchema.parse({
        intent: "chat",
        ambiguities: [{ code: "x", impact: "unknown", question: "?" }]
      })
    ).toThrow();
  });

  it("applies goal, step, and budget defaults", () => {
    const goal = agentGoalSchema.parse({
      instruction: "续写下一章",
      request_snapshot: {
        content: "续写下一章",
        api_key: "must-not-be-persisted"
      }
    });
    expect(goal).toEqual({
      instruction: "续写下一章",
      autonomy_mode: "plan",
      requested_outputs: [],
      success_criteria: [],
      assumptions: [],
      blocking_questions: [],
      request_snapshot: {
        content: "续写下一章",
        attachment_refs: [],
        selected_file_refs: [],
        settings_snapshot: {},
        feature_flag_snapshot: {
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
        }
      }
    });
    expect(goal.request_snapshot).not.toHaveProperty("api_key");

    const step = agentExecutionStepSchema.parse({
      step_id: "step-1",
      index: 0,
      type: "chat",
      action_id: "reply_to_user",
      idempotency_key: "run-1:step-1:1",
      expected_output: { artifact_kind: "chat_answer" }
    });
    expect(step).toMatchObject({
      version: 1,
      type: "chat",
      necessity: "required",
      status: "pending",
      attempts: 0,
      max_attempts: 2,
      retryable: false,
      requires_confirmation: false,
      input_refs: [],
      base_document_versions: {},
      base_content_hashes: {},
      error_code: "",
      error: ""
    });
    expect(step.expected_output).toEqual({
      artifact_kind: "chat_answer",
      allow_empty: false,
      format_schema: {},
      target_path_pattern: "",
      minimum_checks: []
    });
    expect(agentExecutionStepSchema.parse({ ...step, error_code: "MODEL_TIMEOUT", error: "timed out" })).toMatchObject({
      error_code: "MODEL_TIMEOUT",
      error: "timed out"
    });
    expect(() => agentExecutionStepSchema.parse({ ...step, error_code: 500 })).toThrow();
    expect(() => agentExecutionStepSchema.parse({ ...step, version: 0 })).toThrow();
    expect(() => agentExecutionStepSchema.parse({ ...step, necessity: "conditional" })).toThrow();

    const budget = {
      schema_version: 1 as const,
      budget_id: "budget-1",
      profile_id: "test-profile",
      max_steps: 3,
      max_replans: 1,
      max_model_calls: 4,
      max_input_tokens: 32_000,
      max_output_tokens: 8_000,
      max_estimated_cost: 1,
      deadline_at: "2026-07-10T01:00:00.000Z",
      used_steps: 0,
      used_replans: 0,
      used_model_calls: 0,
      used_input_tokens: 0,
      used_output_tokens: 0,
      estimated_cost: 0
    };
    expect(agentRunBudgetSchema.parse(budget)).toEqual(budget);
  });

  it("keeps attempt history and artifact/observation ownership explicit", () => {
    const attemptInput = {
      attempt_id: "attempt-1",
      run_id: "run-1",
      step_id: "step-1",
      attempt: 1,
      idempotency_key: "run-1:step-1:1",
      started_at: "2026-07-10T00:00:00.000Z"
    };
    const attempt = agentStepAttemptSchema.parse(attemptInput);

    expect(attempt).toMatchObject({
      status: "running",
      input_digest: "",
      observation_id: "",
      model_call_refs: [],
      error_code: "",
      error: "",
      ended_at: ""
    });
    expect(agentStepAttemptSchema.parse({ ...attemptInput, status: "interrupted" }).status).toBe("interrupted");
    expect(() => agentStepAttemptSchema.parse({ ...attemptInput, attempt: 0 })).toThrow();

    const artifact = agentArtifactRefSchema.parse({
      artifact_id: "artifact-1",
      kind: "chat_answer",
      created_by_step_id: "step-1",
      created_by_attempt_id: "attempt-1"
    });
    expect(artifact.created_by_attempt_id).toBe("attempt-1");

    const observationInput = {
      observation_id: "observation-1",
      run_id: "run-1",
      step_id: "step-1",
      attempt_id: "attempt-1",
      ok: true,
      verification: { passed: true },
      created_at: "2026-07-10T00:00:01.000Z"
    };
    expect(agentObservationSchema.parse(observationInput)).toMatchObject({
      attempt_id: "attempt-1",
      output_refs: [],
      saved_paths: [],
      warnings: []
    });
    expect(() =>
      agentObservationSchema.parse({
        observation_id: "observation-2",
        run_id: "run-1",
        step_id: "step-1",
        ok: true,
        verification: { passed: true },
        created_at: "2026-07-10T00:00:02.000Z"
      })
    ).toThrow();
  });

  it("enforces budget boundaries", () => {
    const budget = {
      schema_version: 1 as const,
      budget_id: "budget-1",
      profile_id: "test-profile",
      max_steps: 3,
      max_replans: 1,
      max_model_calls: 4,
      max_input_tokens: 32_000,
      max_output_tokens: 8_000,
      max_estimated_cost: 1,
      deadline_at: "2026-07-10T01:00:00.000Z",
      used_steps: 0,
      used_replans: 0,
      used_model_calls: 0,
      used_input_tokens: 0,
      used_output_tokens: 0,
      estimated_cost: 0
    };
    expect(() => agentRunBudgetSchema.parse({ ...budget, max_steps: 0 })).toThrow();
    expect(() => agentRunBudgetSchema.parse({ ...budget, max_replans: -1 })).toThrow();
    expect(() => agentRunBudgetSchema.parse({ ...budget, used_output_tokens: -1 })).toThrow();
    expect(() => agentRunBudgetSchema.parse({ ...budget, max_estimated_cost: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => agentRunBudgetSchema.parse({ ...budget, deadline_at: "not-a-date" })).toThrow();
    expect(() => agentRunBudgetSchema.parse({ ...budget, max_cost: 1 })).toThrow();
    expect(agentRunBudgetSchema.parse({ ...budget, max_replans: 0 })).toMatchObject({ max_replans: 0 });
  });

  it("parses confirmations and run events with safe defaults", () => {
    const confirmation = agentConfirmationSchema.parse({
      confirmation_id: "confirmation-1",
      run_id: "run-1",
      step_id: "step-1",
      action: "replace_document",
      risk_level: "high"
    });
    expect(confirmation).toMatchObject({
      version: 1,
      status: "pending",
      target_paths: [],
      expected_versions: {},
      expected_hashes: {},
      proposed_artifact_refs: []
    });
    expect(confirmation).not.toHaveProperty("resolved_at");
    expect(confirmation).not.toHaveProperty("resolved_by");
    expect(() => agentConfirmationSchema.parse({ ...confirmation, version: 0 })).toThrow();

    const event = agentRunEventSchema.parse({
      event_id: "event-1",
      run_id: "run-1",
      sequence: 1,
      event_type: "run.created",
      created_at: "2026-07-10T00:00:00.000Z"
    });
    expect(event).toMatchObject({ step_id: "", payload: {} });
    expect(() => agentRunEventSchema.parse({ ...event, sequence: 0 })).toThrow();
  });

  it("parses a restartable run state", () => {
    const run = agentRunStateSchema.parse({
      run_id: "run-1",
      goal: {
        instruction: "参考当前章纲续写",
        success_criteria: ["产出非空正文"],
        request_snapshot: {
          content: "续写下一章",
          attachment_refs: ["attachment-1"],
          selected_file_refs: ["01_正文/第1章.md"]
        }
      },
      budget: {
        schema_version: 1,
        budget_id: "budget-run-1",
        profile_id: "test-profile",
        max_steps: 3,
        max_replans: 1,
        max_model_calls: 4,
        max_input_tokens: 32_000,
        max_output_tokens: 8_000,
        max_estimated_cost: 1,
        deadline_at: "2026-07-10T01:00:00.000Z",
        used_steps: 0,
        used_replans: 0,
        used_model_calls: 0,
        used_input_tokens: 0,
        used_output_tokens: 0,
        estimated_cost: 0
      },
      created_at: "2026-07-10T00:00:00.000Z",
      updated_at: "2026-07-10T00:00:00.000Z"
    });

    expect(run).toMatchObject({
      schema_version: 1,
      version: 1,
      run_id: "run-1",
      request_id: "",
      goal_revision: 1,
      plan_version: 1,
      plan_status: "draft",
      status: "queued",
      current_step_id: "",
      runtime_instance_id: "",
      heartbeat_at: "",
      lease_expires_at: "",
      pause_requested_at: "",
      cancel_requested_at: "",
      recovery_reason: "",
      error_code: "",
      error: "",
      steps: [],
      artifacts: [],
      last_event_sequence: 0
    });
    expect(run.goal.request_snapshot).toEqual({
      content: "续写下一章",
      attachment_refs: ["attachment-1"],
      selected_file_refs: ["01_正文/第1章.md"],
      settings_snapshot: {},
      feature_flag_snapshot: {
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
      }
    });
    expect("legacy_unbudgeted" in run.budget).toBe(false);
    if ("legacy_unbudgeted" in run.budget) {
      throw new Error("expected canonical budget");
    }
    expect(run.budget.max_steps).toBe(3);
    expect(agentRunStateSchema.parse({ ...run, error_code: "RUN_RECOVERY_FAILED", error: "recovery failed" })).toMatchObject({
      error_code: "RUN_RECOVERY_FAILED",
      error: "recovery failed"
    });
    expect(() => agentRunStateSchema.parse({ ...run, error: { message: "invalid" } })).toThrow();
    expect(() => agentRunStateSchema.parse({ ...run, version: 0 })).toThrow();
    expect(() => agentRunStateSchema.parse({ ...run, goal_revision: 0 })).toThrow();
    expect(() => agentRunStateSchema.parse({ ...run, plan_version: 0 })).toThrow();
  });

  it("whitelists recoverable Agent request fields and strips credentials or arbitrary extensions", () => {
    const request = agentRecoverableRequestSchema.parse({
      request_id: "request-1",
      content: "继续写作",
      custom_prompt: "保留工作流提示",
      conversation_write_target: "02_正文/第一章.txt",
      conversation_write_mode: "append",
      conversation_confirm_write: true,
      api_key: "must-not-persist",
      nested_private_payload: { token: "must-not-persist" }
    });

    expect(request).toMatchObject({
      request_id: "request-1",
      content: "继续写作",
      custom_prompt: "保留工作流提示",
      conversation_write_target: "02_正文/第一章.txt",
      conversation_write_mode: "append",
      conversation_confirm_write: true
    });
    expect(request).not.toHaveProperty("api_key");
    expect(request).not.toHaveProperty("nested_private_payload");
  });

  it("requires a complete strict feature flag snapshot", () => {
    expect(() =>
      agentGoalSchema.parse({
        request_snapshot: {
          feature_flag_snapshot: { schema_version: 1, agent_execution_v2_mode: "on" }
        }
      })
    ).toThrow();
    expect(() =>
      agentGoalSchema.parse({
        request_snapshot: {
          feature_flag_snapshot: {
            schema_version: 1,
            agent_execution_v2_mode: "on",
            model_gateway_v2: false,
            agent_replanning_v2: false,
            context_budget_v2: false,
            memory_v2: false,
            memory_context_selector_v2: false,
            quality_gate_v2: false,
            agent_event_stream_v2: false,
            agent_inline_plan_ui: false,
            unknown_flag: true
          }
        }
      })
    ).toThrow();
  });

  it("parses run lifecycle API envelopes and command requests", () => {
    const run = {
      run_id: "run-1",
      goal: { instruction: "续写下一章" },
      budget: {
        schema_version: 0,
        budget_id: "",
        profile_id: "legacy_unbudgeted",
        legacy_unbudgeted: true
      },
      created_at: "2026-07-10T00:00:00.000Z",
      updated_at: "2026-07-10T00:00:00.000Z"
    };
    const event = {
      event_id: "event-1",
      run_id: "run-1",
      sequence: 3,
      event_type: "run.paused",
      created_at: "2026-07-10T00:00:03.000Z"
    };

    const list = agentRunListResponseSchema.parse({ runs: [run], next_cursor: "cursor-2" });
    expect(list.runs[0]).toMatchObject({ run_id: "run-1", status: "queued", version: 1 });
    expect(list.next_cursor).toBe("cursor-2");
    expect(agentRunListResponseSchema.parse({ runs: [], next_cursor: null })).toEqual({
      runs: [],
      next_cursor: null
    });

    const replay = agentRunEventReplayResponseSchema.parse({
      events: [event],
      next_after: 3,
      next_sequence: 3,
      has_more: true,
      earliest_available_sequence: 2,
      gap_detected: true
    });
    expect(replay.events[0]).toMatchObject({ sequence: 3, step_id: "", payload: {} });
    expect(replay.next_after).toBe(3);
    expect(replay).toMatchObject({ next_sequence: 3, has_more: true, earliest_available_sequence: 2, gap_detected: true });

    const command = { operation_id: "operation-1", expected_version: 4 };
    const confirmationCommand = { ...command, expected_scope_fingerprint: "scope-fingerprint-1" };
    expect(agentRunControlRequestSchema.parse(command)).toEqual(command);
    expect(agentStepRetryRequestSchema.parse(command)).toEqual(command);
    expect(agentConfirmationResolveRequestSchema.parse(confirmationCommand)).toEqual(confirmationCommand);
    expect(() => agentRunControlRequestSchema.parse({ operation_id: "", expected_version: 4 })).toThrow();
    expect(() => agentStepRetryRequestSchema.parse({ operation_id: "operation-1", expected_version: 0 })).toThrow();
    expect(() => agentRunEventReplayResponseSchema.parse({ events: [], next_after: -1 })).toThrow();
  });

  it("keeps legacy stream events valid while allowing run correlation", () => {
    expect(
      agentStreamEventSchema.parse({
        type: "start",
        intent: "chat",
        conversation_id: "conversation-1"
      })
    ).toMatchObject({ type: "start", skill_id: "" });
    expect(
      agentStreamEventSchema.parse({
        type: "start",
        run_id: "run-1",
        intent: "chat",
        conversation_id: "conversation-1"
      })
    ).toMatchObject({ type: "start", run_id: "run-1" });

    expect(agentStreamEventSchema.parse({ type: "error", message: "failed" })).toEqual({
      type: "error",
      message: "failed"
    });
    expect(
      agentStreamEventSchema.parse({
        type: "error",
        run_id: "run-1",
        error_code: "MODEL_TIMEOUT",
        message: "failed"
      })
    ).toMatchObject({ run_id: "run-1", error_code: "MODEL_TIMEOUT" });

    expect(
      agentStreamEventSchema.parse({
        type: "final",
        payload: {
          run_id: "run-1",
          intent: "chat",
          reply: "完成",
          results: [],
          saved_paths: [],
          requires_confirmation: false
        }
      })
    ).toMatchObject({ type: "final", payload: { run_id: "run-1" } });
  });

  it("applies project file read caps", () => {
    const parsed = projectFileReadRequestSchema.parse({});

    expect(parsed.max_chars_per_file).toBe(12000);
    expect(parsed.max_total_chars).toBe(36000);
    expect(() => projectFileReadRequestSchema.parse({ max_chars_per_file: 499 })).toThrow();
    expect(() => projectFileReadRequestSchema.parse({ max_total_chars: 120001 })).toThrow();
  });
});
