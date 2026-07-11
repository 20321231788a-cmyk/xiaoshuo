import { describe, expect, it } from "vitest";
import {
  AGENT_BUDGET_ERROR_CODES,
  assertBudgetResumable,
  issueDefaultAgentBudget,
  materializeBudgetState
} from "./budget-policy.js";

describe("durable run budget policy", () => {
  it("mints strict trusted profiles without accepting usage from a request", () => {
    const issuedAt = "2026-07-11T00:00:00.000Z";
    const grant = issueDefaultAgentBudget({
      actionId: "agent.chat",
      stepType: "chat",
      autonomyMode: "plan",
      issuedAt
    });
    const budget = materializeBudgetState("run-1", grant, issuedAt);

    expect(budget).toMatchObject({
      budget_id: "budget_run-1",
      profile_id: "interactive_agent_v1",
      used_steps: 0,
      used_replans: 0,
      used_model_calls: 0,
      used_input_tokens: 0,
      used_output_tokens: 0,
      estimated_cost: 0
    });
  });

  it.each([
    ["used_steps", "max_steps", AGENT_BUDGET_ERROR_CODES.stepsExceeded],
    ["used_replans", "max_replans", AGENT_BUDGET_ERROR_CODES.replansExceeded],
    ["used_model_calls", "max_model_calls", AGENT_BUDGET_ERROR_CODES.modelCallsExceeded],
    ["used_input_tokens", "max_input_tokens", AGENT_BUDGET_ERROR_CODES.inputTokensExceeded],
    ["used_output_tokens", "max_output_tokens", AGENT_BUDGET_ERROR_CODES.outputTokensExceeded],
    ["estimated_cost", "max_estimated_cost", AGENT_BUDGET_ERROR_CODES.costExceeded]
  ] as const)("fails closed when %s reaches its limit", (usedKey, maxKey, code) => {
    const issuedAt = "2026-07-11T00:00:00.000Z";
    const budget = materializeBudgetState("run-1", issueDefaultAgentBudget({
      actionId: "agent.chat",
      stepType: "chat",
      autonomyMode: "plan",
      issuedAt
    }), issuedAt);
    const exhausted = { ...budget, [usedKey]: budget[maxKey] };

    expect(() => assertBudgetResumable(exhausted, "2026-07-11T00:01:00.000Z")).toThrow(
      expect.objectContaining({ code })
    );
  });

  it("rejects legacy and expired budgets", () => {
    expect(() => assertBudgetResumable({
      schema_version: 0,
      budget_id: "",
      profile_id: "legacy_unbudgeted",
      legacy_unbudgeted: true
    }, "2026-07-11T00:00:00.000Z")).toThrow(expect.objectContaining({ code: AGENT_BUDGET_ERROR_CODES.required }));

    const issuedAt = "2026-07-11T00:00:00.000Z";
    const budget = materializeBudgetState("run-1", issueDefaultAgentBudget({
      actionId: "agent.chat",
      stepType: "chat",
      autonomyMode: "plan",
      issuedAt
    }), issuedAt);
    expect(() => assertBudgetResumable(budget, budget.deadline_at)).toThrow(
      expect.objectContaining({ code: AGENT_BUDGET_ERROR_CODES.deadlineExceeded })
    );
  });
});
