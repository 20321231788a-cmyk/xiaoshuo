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

  it("moves a confirmed outline group into one recoverable archive batch", async () => {
    const fixture = await createArchiveFixture();
    const preview = await fixture.runner.runAgent(fixture.request, fixture.previewContext);
    const scope = preview.confirmation_scope!;
    const consume = vi.fn(async () => ({ applied: true as const, value: {} as never }));

    const result = await fixture.runner.runAgent(fixture.request, {
      ...fixture.previewContext,
      attemptId: "archive-attempt-2",
      requiresConfirmation: false,
      confirmationReceiptId: "archive-confirmation-1",
      confirmationReceiptVersion: 2,
      confirmationScopeFingerprint: scope.scope_fingerprint,
      confirmationActionInputHash: scope.action_input_hash,
      confirmationTargetBindings: scope.target_bindings,
      confirmationActionPayload: scope.action_payload,
      consumeConfirmationReceipt: consume
    });

    expect(consume).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("已将 5 个文件移入项目回收站，可在项目时间线恢复。");
    expect(result.results.every((item) => item.ok)).toBe(true);
    const [batchDirectory] = await fs.readdir(path.join(fixture.projectRoot, "99_回收站"));
    for (const relativePath of fixture.paths) {
      await expect(fs.access(path.join(fixture.projectRoot, ...relativePath.split("/")))).rejects.toThrow();
      expect(await fs.readFile(path.join(fixture.projectRoot, "99_回收站", batchDirectory!, ...relativePath.split("/")), "utf8"))
        .toContain("大纲资料");
    }
  });

  it("allows an explicitly trusted global direct-file policy to archive a resolved group", async () => {
    const fixture = await createArchiveFixture();

    const result = await fixture.runner.runAgent(fixture.request, {
      ...fixture.previewContext,
      requiresConfirmation: false,
      directProjectFilePermission: true
    });

    expect(result.requires_confirmation).toBe(false);
    expect(result.reply).toBe("已将 5 个文件移入项目回收站，可在项目时间线恢复。");
    expect(result.results.every((item) => item.ok)).toBe(true);
    for (const relativePath of fixture.paths) {
      await expect(fs.access(path.join(fixture.projectRoot, ...relativePath.split("/")))).rejects.toThrow();
    }
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

async function createArchiveFixture() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "file-confirmation-archive-"));
  projects.push(projectRoot);
  const paths = [
    "01_大纲/大纲.txt",
    "01_大纲/故事大纲.md",
    "01_大纲/故事时间线.md",
    "01_大纲/细纲.txt",
    "01_大纲/章纲.txt"
  ];
  await Promise.all(paths.map(async (relativePath) => {
    const target = path.join(projectRoot, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `大纲资料：${relativePath}`, "utf8");
  }));
  const plan = {
    operations: paths.map((filePath) => ({
      action: "archive_file" as const,
      path: filePath,
      text: "",
      old_text: "",
      new_text: "",
      target_path: "",
      reason: "删除当前大纲",
      requires_confirmation: true
    })),
    summary: "移入回收站 5 个大纲文件",
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
    paths,
    runner,
    request: {
      conversation_id: "",
      content: "删除现在的大纲",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "",
      attachment_ids: []
    },
    previewContext: {
      runId: "archive-run-1",
      stepId: "archive-step-1",
      attemptId: "archive-attempt-1",
      projectId: "project-archive",
      planVersion: 1,
      requiresConfirmation: true
    }
  };
}
