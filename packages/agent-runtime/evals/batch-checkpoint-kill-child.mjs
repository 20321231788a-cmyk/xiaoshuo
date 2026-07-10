import { RunCoordinator } from "../dist/kernel/run-coordinator.js";
import { DurableWorkflowCheckpointStore } from "../dist/kernel/workflow-checkpoint.js";
import { BatchGenerateWorkflow } from "../dist/workflows/batch-generate.js";
import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = process.argv[2];
if (!projectRoot) {
  throw new Error("projectRoot is required");
}

const sideEffectLog = path.join(projectRoot, "batch-side-effects.log");
const request = {
  request_id: "batch-checkpoint-forced-kill",
  conversation_id: "",
  content: "生成第1章到第2章正文并写入文件",
  current_path: "",
  selection: "",
  project_context_hint: "",
  skill_id: "batch_generate",
  attachment_ids: [],
  suppress_conversation_record: true
};
const coordinator = new RunCoordinator({
  projectRoot,
  runtimeInstanceId: "runtime-batch-kill-child",
  leaseTtlMs: 50,
  autoHeartbeat: false
});
const execution = coordinator.beginRun(request, { stepType: "workflow", retryable: true });
const durableCheckpoint = new DurableWorkflowCheckpointStore(coordinator.store, {
  runId: execution.run_id,
  stepId: execution.step_id,
  attemptId: execution.attempt_id
});
const checkpoint = {
  listCompletedUnits: (workflowId) => durableCheckpoint.listCompletedUnits(workflowId),
  completeUnit: (unit) => {
    const saved = durableCheckpoint.completeUnit(unit);
    if (unit.unit_id === "chapter:1") {
      process.send?.({ run_id: execution.run_id, step_id: execution.step_id, side_effect_log: sideEffectLog });
      // The checkpoint is committed before this deliberate hang. The parent kills
      // this process during the exact crash window before chapter 2 begins.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    }
    return saved;
  }
};
const bodyHandler = {
  id: "body_generate",
  async runAgent(chapterRequest) {
    const chapter = Number(/第(\d+)章/.exec(chapterRequest.content || "")?.[1] || 0);
    const savedPath = `02_正文/第${String(chapter).padStart(3, "0")}章.txt`;
    await fs.appendFile(sideEffectLog, `model:${chapter}\nwrite:${chapter}\n`, "utf8");
    return {
      intent: "skill",
      reply: `已写入 ${savedPath}`,
      results: [],
      skill_result: { status: "done", result: `第${chapter}章正文`, saved_path: savedPath, data: { chapter, saved_paths: [savedPath] } },
      saved_paths: [savedPath],
      requires_confirmation: false
    };
  }
};

const workflow = new BatchGenerateWorkflow(bodyHandler);
await workflow.runAgent(request, { projectRoot, checkpoint });
