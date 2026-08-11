import { describe, expect, it } from "vitest";
import {
  NEGATIVE_CAPABILITY_CODES,
  NegativeCapabilityPolicy,
  NegativeCapabilityPolicyError
} from "./negative-capability-policy.js";

const base = {
  actor: "agent" as const,
  project_id: "project-a",
  run_id: "run-a",
  budget_id: "budget-a",
  confirmation_id: null
};

function expectDenied(invoke: () => void, code: string) {
  try {
    invoke();
    throw new Error("Expected policy rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(NegativeCapabilityPolicyError);
    expect(error).toMatchObject({ code });
  }
}

describe("NegativeCapabilityPolicy", () => {
  it("allows only the registered single-agent action surface", () => {
    const policy = new NegativeCapabilityPolicy();

    expect(() => policy.assertAllowed({ ...base, capability: "agent.action.run_skill" })).not.toThrow();
    expectDenied(() => policy.assertAllowed({ ...base, capability: "agent.action.spawn_child" }), NEGATIVE_CAPABILITY_CODES.unknown);
  });

  it("requires trusted durable run and budget identities for every Agent action", () => {
    const policy = new NegativeCapabilityPolicy();

    expectDenied(
      () => policy.assertAllowed({ ...base, capability: "agent.action.run_skill", run_id: null }),
      NEGATIVE_CAPABILITY_CODES.budgetRequired
    );
    expectDenied(
      () => policy.assertAllowed({ ...base, capability: "agent.action.run_skill", budget_id: null }),
      NEGATIVE_CAPABILITY_CODES.budgetRequired
    );
  });

  it.each([
    ["agent.spawn", NEGATIVE_CAPABILITY_CODES.singleAgent],
    ["agent.delegate", NEGATIVE_CAPABILITY_CODES.singleAgent],
    ["dependency.install.npm", NEGATIVE_CAPABILITY_CODES.dependencyInstall],
    ["shell.execute", NEGATIVE_CAPABILITY_CODES.shellExecution],
    ["terminal.create", NEGATIVE_CAPABILITY_CODES.shellExecution],
    ["runtime.modify", NEGATIVE_CAPABILITY_CODES.runtimeMutation],
    ["runtime.publish", NEGATIVE_CAPABILITY_CODES.runtimeMutation],
    ["background.autonomous", NEGATIVE_CAPABILITY_CODES.unbudgetedAutonomy],
    ["project.write.cross", NEGATIVE_CAPABILITY_CODES.crossProjectWrite],
    ["memory.confirm", NEGATIVE_CAPABILITY_CODES.confirmedMemory]
  ])("rejects excluded capability %s", (capability, code) => {
    const policy = new NegativeCapabilityPolicy();

    expectDenied(() => policy.assertAllowed({ ...base, capability }), code);
  });

  it("rejects agent cross-project scope even if a confirmation value is supplied", () => {
    const policy = new NegativeCapabilityPolicy();

    expectDenied(() => policy.assertAllowed({
      ...base,
      capability: "agent.action.propose_save",
      confirmation_id: "replayed-confirmation",
      target_project_id: "project-b"
    }), NEGATIVE_CAPABILITY_CODES.crossProjectWrite);
  });

  it("keeps manual terminal separate and requires a user confirmation ticket", () => {
    const policy = new NegativeCapabilityPolicy();
    const request = {
      actor: "user_ui" as const,
      capability: "user_terminal",
      project_id: "project-a",
      run_id: null,
      budget_id: null,
      confirmation_id: null
    };

    expectDenied(() => policy.assertAllowed(request), NEGATIVE_CAPABILITY_CODES.shellExecution);
    expect(() => policy.assertAllowed({ ...request, confirmation_id: "user-gesture-ticket" })).not.toThrow();
  });

  it("fails closed for unknown actors and capabilities", () => {
    const policy = new NegativeCapabilityPolicy();

    expect(() => policy.assertAllowed({ ...base, actor: "model" as never, capability: "agent.action.run_skill" })).toThrow();
    try {
      policy.assertAllowed({ ...base, capability: "network.escalate" });
      throw new Error("Expected policy rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(NegativeCapabilityPolicyError);
      expect(error).toMatchObject({ code: NEGATIVE_CAPABILITY_CODES.unknown });
    }
  });
});
