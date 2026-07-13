import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentFileOperationRunner } from "./file-operation-runner.js";
import { CONFIRMATION_RECEIPT_CODES } from "./kernel/confirmation-receipt.js";

const projects: string[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) {
    await fs.rm(project, { recursive: true, force: true });
  }
});

describe("AgentFileOperationRunner confirmation receipts", () => {
  it("seals the durable direct-save preview used by the confirmation E2E flow", async () => {
    const fixture = await createFixture();

    const preview = await fixture.runner.runAgent({
      ...fixture.request,
      content: "请保存到大纲文件",
      selection: "E2E durable confirmation content.",
      current_path: "01_大纲/大纲.txt"
    }, fixture.previewContext);

    expect(fixture.buildPlan).not.toHaveBeenCalled();
    expect(preview.requires_confirmation).toBe(true);
    expect(preview.plan).toMatchObject({
      operations: [expect.objectContaining({
        action: "append_text",
        path: "01_大纲/大纲.txt"
      })]
    });
    expect(preview.confirmation_scope).toMatchObject({
      project_id: "project-1",
      plan_version: 1,
      action_id: "execute_file_plan",
      action_payload: preview.plan
    });
    expect(preview.confirmation_scope?.scope_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.confirmation_scope?.target_bindings).toEqual([
      expect.objectContaining({
        path: "01_大纲/大纲.txt",
        canonical_path: expect.stringMatching(/01_大纲[\\/]大纲\.txt$/),
        base_hash: expect.any(String),
        proposed_hash: expect.any(String)
      })
    ]);
  });

  it("executes the persisted preview without replanning and consumes before writing", async () => {
    const fixture = await createFixture();
    const preview = await fixture.runner.runAgent(fixture.request, fixture.previewContext);
    const scope = preview.confirmation_scope!;
    const order: string[] = [];
    const consume = vi.fn(async () => {
      order.push("consume");
      return { applied: true, value: {} as never } as const;
    });

    const result = await fixture.runner.runAgent(fixture.request, {
      ...fixture.previewContext,
      attemptId: "attempt-2",
      requiresConfirmation: false,
      confirmationReceiptId: "confirmation-1",
      confirmationReceiptVersion: 2,
      confirmationScopeFingerprint: scope.scope_fingerprint,
      confirmationActionInputHash: scope.action_input_hash,
      confirmationTargetBindings: scope.target_bindings,
      confirmationActionPayload: scope.action_payload,
      consumeConfirmationReceipt: consume
    });
    order.push(`disk:${await fs.readFile(path.join(fixture.projectRoot, "01_大纲", "大纲.txt"), "utf8")}`);

    expect(fixture.buildPlan).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["consume", "disk:new text"]);
    expect(result.requires_confirmation).toBe(false);
    expect(result.plan).toEqual(preview.plan);
  });

  it("rejects a changed target before consuming or writing", async () => {
    const fixture = await createFixture();
    const preview = await fixture.runner.runAgent(fixture.request, fixture.previewContext);
    const scope = preview.confirmation_scope!;
    const consume = vi.fn();
    await fs.writeFile(path.join(fixture.projectRoot, "01_大纲", "大纲.txt"), "changed elsewhere", "utf8");

    await expect(fixture.runner.runAgent(fixture.request, {
      ...fixture.previewContext,
      attemptId: "attempt-2",
      requiresConfirmation: false,
      confirmationReceiptId: "confirmation-1",
      confirmationReceiptVersion: 2,
      confirmationScopeFingerprint: scope.scope_fingerprint,
      confirmationActionInputHash: scope.action_input_hash,
      confirmationTargetBindings: scope.target_bindings,
      confirmationActionPayload: scope.action_payload,
      consumeConfirmationReceipt: consume
    })).rejects.toMatchObject({
      code: expect.stringMatching(
        `${CONFIRMATION_RECEIPT_CODES.versionMismatch}|${CONFIRMATION_RECEIPT_CODES.hashMismatch}`
      )
    });

    expect(fixture.buildPlan).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(fixture.projectRoot, "01_大纲", "大纲.txt"), "utf8"))
      .toBe("changed elsewhere");
  });
});

async function createFixture() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "file-confirmation-"));
  projects.push(projectRoot);
  await fs.mkdir(path.join(projectRoot, "01_大纲"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "01_大纲", "大纲.txt"), "old text", "utf8");
  const plan = {
    operations: [{
      action: "replace_text" as const,
      path: "01_大纲/大纲.txt",
      text: "",
      old_text: "old text",
      new_text: "new text",
      target_path: "",
      reason: "confirmed replacement",
      requires_confirmation: false
    }],
    summary: "replace outline",
    warnings: [],
    can_execute: true
  };
  const buildPlan = vi.fn(async () => plan);
  const runner = new AgentFileOperationRunner({
    planner: { buildPlan } as never,
    projectRoot
  });
  return {
    projectRoot,
    runner,
    buildPlan,
    request: {
      conversation_id: "",
      content: "replace outline",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "",
      attachment_ids: []
    },
    previewContext: {
      runId: "run-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      projectId: "project-1",
      planVersion: 1,
      requiresConfirmation: true
    }
  };
}
