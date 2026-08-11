import { describe, expect, it, vi } from "vitest";
import { ActionExecutor } from "./action-executor.js";
import {
  CONFIRMATION_RECEIPT_CODES,
  sha256StableJson
} from "./kernel/confirmation-receipt.js";

describe("ActionExecutor confirmation receipts", () => {
  it("does not consume a receipt for actions whose policy is never", async () => {
    const consume = vi.fn();
    const executor = new ActionExecutor({
      projectManifest: { getProjectId: vi.fn().mockResolvedValue("project-1") }
    }, {
      projectId: "project-1",
      runId: "run-1",
      budgetId: "budget-1",
      consumeConfirmationReceipt: consume
    });

    await expect(executor.execute("read_project_files", {})).resolves.toBe("project-1");
    expect(consume).not.toHaveBeenCalled();
  });

  it("rejects always actions before the handler when trusted receipt state is missing", async () => {
    const executor = new ActionExecutor({}, {
      projectId: "project-1",
      runId: "run-1",
      budgetId: "budget-1"
    });

    await expect(executor.execute("propose_save", {
      path: "draft.txt",
      confirmation_id: "renderer-spoof"
    })).rejects.toMatchObject({ code: CONFIRMATION_RECEIPT_CODES.required });
  });

  it("atomically consumes the trusted receipt before handling an always action", async () => {
    const calls: string[] = [];
    const args = { path: "draft.txt" };
    const consume = vi.fn(async () => {
      calls.push("consume");
      return { applied: true, value: {} as never } as const;
    });
    const executor = new ActionExecutor({}, {
      projectId: "project-1",
      runId: "run-1",
      budgetId: "budget-1",
      stepId: "step-1",
      attemptId: "attempt-2",
      planVersion: 1,
      confirmationId: "confirmation-1",
      confirmationReceipt: {
        confirmationId: "confirmation-1",
        version: 2,
        scopeFingerprint: "sha256:scope",
        actionInputHash: sha256StableJson(args),
        targetBindings: []
      },
      consumeConfirmationReceipt: consume
    });

    await expect(executor.execute("propose_save", args)).resolves.toMatchObject({ ok: true, path: "draft.txt" });
    expect(calls).toEqual(["consume"]);
    expect(consume).toHaveBeenCalledWith(expect.objectContaining({
      confirmation_id: "confirmation-1",
      expected_version: 2,
      run_id: "run-1",
      step_id: "step-1",
      attempt_id: "attempt-2",
      action: "propose_save",
      project_id: "project-1",
      plan_version: 1,
      action_input_hash: sha256StableJson(args),
      scope_fingerprint: "sha256:scope"
    }));
  });
});
