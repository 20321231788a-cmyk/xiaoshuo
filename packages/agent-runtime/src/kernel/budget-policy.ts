import {
  agentRunBudgetEnvelopeSchema,
  agentRunBudgetSchema,
  type AgentAutonomyMode,
  type AgentExecutionStepType,
  type AgentRunBudget,
  type AgentRunBudgetEnvelope,
  type PersistedAgentRunBudget
} from "@xiaoshuo/shared";
import { createHash } from "node:crypto";

export const AGENT_BUDGET_ERROR_CODES = Object.freeze({
  required: "BUDGET_REQUIRED",
  invalid: "BUDGET_INVALID",
  deadlineExceeded: "BUDGET_DEADLINE_EXCEEDED",
  stepsExceeded: "BUDGET_STEPS_EXCEEDED",
  replansExceeded: "BUDGET_REPLANS_EXCEEDED",
  modelCallsExceeded: "BUDGET_MODEL_CALLS_EXCEEDED",
  inputTokensExceeded: "BUDGET_INPUT_TOKENS_EXCEEDED",
  outputTokensExceeded: "BUDGET_OUTPUT_TOKENS_EXCEEDED",
  costExceeded: "BUDGET_COST_EXCEEDED",
  stateConflict: "BUDGET_STATE_CONFLICT"
} as const);

export type AgentBudgetErrorCode = (typeof AGENT_BUDGET_ERROR_CODES)[keyof typeof AGENT_BUDGET_ERROR_CODES];

export class AgentBudgetPolicyError extends Error {
  constructor(
    readonly code: AgentBudgetErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AgentBudgetPolicyError";
  }
}

export type TrustedBudgetProfileContext = {
  actionId: string;
  stepType: AgentExecutionStepType;
  autonomyMode: AgentAutonomyMode;
  issuedAt: string;
};

export type TrustedBudgetGrant = {
  profileId: string;
  envelope: AgentRunBudgetEnvelope;
};

export type TrustedBudgetProfileIssuer = (context: TrustedBudgetProfileContext) => TrustedBudgetGrant;

const MINUTE_MS = 60_000;

export const issueDefaultAgentBudget: TrustedBudgetProfileIssuer = (context) => {
  const issuedAtMs = Date.parse(context.issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    throw new AgentBudgetPolicyError(AGENT_BUDGET_ERROR_CODES.invalid, "预算签发时间无效");
  }

  if (context.actionId === "agent.generated_cache_commit" || context.actionId === "agent.card_draw_select") {
    return grant("controlled_write_v1", issuedAtMs, 5 * MINUTE_MS, {
      max_steps: 32,
      max_replans: 1,
      max_model_calls: 1,
      max_input_tokens: 4_096,
      max_output_tokens: 4_096,
      max_estimated_cost: 0.1
    });
  }

  if (context.actionId.startsWith("skill.")) {
    return grant("prompt_skill_v1", issuedAtMs, 15 * MINUTE_MS, {
      max_steps: 16,
      max_replans: 2,
      max_model_calls: 24,
      max_input_tokens: 256_000,
      max_output_tokens: 64_000,
      max_estimated_cost: 10
    });
  }

  return grant("interactive_agent_v1", issuedAtMs, 10 * MINUTE_MS, {
    max_steps: 8,
    max_replans: 1,
    max_model_calls: 16,
    max_input_tokens: 128_000,
    max_output_tokens: 32_000,
    max_estimated_cost: 5
  });
};

export function materializeBudgetState(
  runId: string,
  grantInput: TrustedBudgetGrant,
  issuedAt: string
): AgentRunBudget {
  const profileId = String(grantInput.profileId || "").trim();
  if (!profileId) {
    throw new AgentBudgetPolicyError(AGENT_BUDGET_ERROR_CODES.invalid, "预算 profile_id 不能为空");
  }
  const envelope = parseGrantEnvelope(grantInput.envelope, issuedAt);
  return agentRunBudgetSchema.parse({
    schema_version: 1,
    budget_id: `budget_${runId}`,
    profile_id: profileId,
    ...envelope,
    used_steps: 0,
    used_replans: 0,
    used_model_calls: 0,
    used_input_tokens: 0,
    used_output_tokens: 0,
    estimated_cost: 0
  });
}

export function validateTrustedBudgetGrant(
  grantInput: TrustedBudgetGrant,
  issuedAt: string
): TrustedBudgetGrant {
  const profileId = String(grantInput.profileId || "").trim();
  if (!profileId) {
    throw new AgentBudgetPolicyError(AGENT_BUDGET_ERROR_CODES.invalid, "预算 profile_id 不能为空");
  }
  return {
    profileId,
    envelope: parseGrantEnvelope(grantInput.envelope, issuedAt)
  };
}

export function assertBudgetResumable(
  budget: PersistedAgentRunBudget,
  now: string
): asserts budget is AgentRunBudget {
  if ("legacy_unbudgeted" in budget) {
    throw new AgentBudgetPolicyError(AGENT_BUDGET_ERROR_CODES.required, "历史 Agent run 未携带可信预算，禁止恢复");
  }
  const nowMs = Date.parse(now);
  const deadlineMs = Date.parse(budget.deadline_at);
  if (!Number.isFinite(nowMs) || !Number.isFinite(deadlineMs)) {
    throw new AgentBudgetPolicyError(AGENT_BUDGET_ERROR_CODES.invalid, "Agent run 预算时间无效");
  }
  if (deadlineMs <= nowMs) {
    throw new AgentBudgetPolicyError(AGENT_BUDGET_ERROR_CODES.deadlineExceeded, "Agent run 已超过预算截止时间");
  }
  assertBelow(budget.used_steps, budget.max_steps, AGENT_BUDGET_ERROR_CODES.stepsExceeded, "步骤");
  assertBelow(budget.used_replans, budget.max_replans, AGENT_BUDGET_ERROR_CODES.replansExceeded, "重规划");
  assertBelow(budget.used_model_calls, budget.max_model_calls, AGENT_BUDGET_ERROR_CODES.modelCallsExceeded, "模型调用");
  assertBelow(budget.used_input_tokens, budget.max_input_tokens, AGENT_BUDGET_ERROR_CODES.inputTokensExceeded, "输入 token");
  assertBelow(budget.used_output_tokens, budget.max_output_tokens, AGENT_BUDGET_ERROR_CODES.outputTokensExceeded, "输出 token");
  assertBelow(budget.estimated_cost, budget.max_estimated_cost, AGENT_BUDGET_ERROR_CODES.costExceeded, "预估成本");
}

export function budgetPolicyFingerprint(
  budget: AgentRunBudget | TrustedBudgetGrant,
  issuedAt: string
): string {
  const issuedAtMs = Date.parse(issuedAt);
  const envelope = "envelope" in budget ? budget.envelope : budget;
  const profileId = "envelope" in budget ? budget.profileId : budget.profile_id;
  const deadlineMs = Date.parse(envelope.deadline_at);
  const payload = {
    profile_id: profileId,
    max_steps: envelope.max_steps,
    max_replans: envelope.max_replans,
    max_model_calls: envelope.max_model_calls,
    max_input_tokens: envelope.max_input_tokens,
    max_output_tokens: envelope.max_output_tokens,
    max_estimated_cost: envelope.max_estimated_cost,
    deadline_ttl_ms: deadlineMs - issuedAtMs
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function grant(
  profileId: string,
  issuedAtMs: number,
  durationMs: number,
  limits: Omit<AgentRunBudgetEnvelope, "deadline_at">
): TrustedBudgetGrant {
  return {
    profileId,
    envelope: agentRunBudgetEnvelopeSchema.parse({
      ...limits,
      deadline_at: new Date(issuedAtMs + durationMs).toISOString()
    })
  };
}

function parseGrantEnvelope(envelope: AgentRunBudgetEnvelope, issuedAt: string): AgentRunBudgetEnvelope {
  let parsed: AgentRunBudgetEnvelope;
  try {
    parsed = agentRunBudgetEnvelopeSchema.parse(envelope);
  } catch (error) {
    throw new AgentBudgetPolicyError(
      AGENT_BUDGET_ERROR_CODES.invalid,
      `可信预算 profile 返回无效 envelope：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (Date.parse(parsed.deadline_at) <= Date.parse(issuedAt)) {
    throw new AgentBudgetPolicyError(AGENT_BUDGET_ERROR_CODES.deadlineExceeded, "可信预算在签发时已过期");
  }
  return parsed;
}

function assertBelow(current: number, maximum: number, code: AgentBudgetErrorCode, label: string): void {
  if (current >= maximum) {
    throw new AgentBudgetPolicyError(code, `Agent run 的${label}预算已耗尽`);
  }
}
