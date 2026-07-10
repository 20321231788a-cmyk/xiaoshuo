import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DocumentService } from "@xiaoshuo/document-service";
import type { AgentRunState } from "@xiaoshuo/shared";
import { afterEach, describe, expect, it } from "vitest";
import { CommitJournalService } from "./commit-journal-service.js";
import { ExecutionStore } from "./execution-store.js";

const projects: string[] = [];
const stores: ExecutionStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(projects.splice(0).map((project) => fs.rm(project, { recursive: true, force: true })));
});

describe("CommitJournalService", () => {
  it("writes through DocumentService using a fenced lease, sibling temp file, backup, and finalized journal", async () => {
    const projectRoot = await temporaryProject();
    const store = track(ExecutionStore.open(projectRoot));
    store.createRun(makeRun(projectRoot));
    const service = new CommitJournalService({
      store,
      projectRoot,
      idFactory: () => "journal-1",
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });

    const result = await service.write(writeInput());

    expect(result).toMatchObject({ replayed: false, document: { content: "new chapter", changed: true } });
    expect(result.journal).toMatchObject({
      journal_id: "journal-1",
      stage: "finalized",
      base_hash: hash("old chapter"),
      new_hash: hash("new chapter"),
      fencing_token: 1
    });
    expect(await fs.readFile(path.join(projectRoot, "02_正文", "第一章.txt"), "utf8")).toBe("new chapter");
    expect(existsSync(result.journal.temp_path)).toBe(false);
    expect(await fs.readFile(result.journal.backup_path, "utf8")).toBe("old chapter");
    expect(await new DocumentService({ projectRoot }).listTimeline()).toHaveLength(1);
  });

  it("reconciles a crash after replacement by comparing the durable new-content hash", async () => {
    const projectRoot = await temporaryProject();
    const store = track(ExecutionStore.open(projectRoot));
    store.createRun(makeRun(projectRoot));
    const service = new CommitJournalService({
      store,
      projectRoot,
      idFactory: () => "journal-crash",
      now: () => new Date("2026-07-10T00:00:00.000Z"),
      afterStage: (stage) => {
        if (stage === "file_replaced") {
          throw new Error("simulated process death after replacement");
        }
      }
    });

    await expect(service.write(writeInput())).rejects.toThrow("simulated process death");
    expect(await fs.readFile(path.join(projectRoot, "02_正文", "第一章.txt"), "utf8")).toBe("new chapter");
    expect(store.listPendingCommitJournal()).toMatchObject([{ stage: "recovery_required" }]);

    const recovered = await new CommitJournalService({
      store,
      projectRoot,
      now: () => new Date("2026-07-10T00:00:01.000Z")
    }).recoverPending();

    expect(recovered).toEqual([{ journalId: "journal-crash", outcome: "finalized_new" }]);
    expect(store.getCommitJournal("journal-crash")).toMatchObject({ stage: "finalized" });
  });

  it("does not replace the target after its fencing token has been superseded", async () => {
    const projectRoot = await temporaryProject();
    const store = track(ExecutionStore.open(projectRoot));
    store.createRun(makeRun(projectRoot));
    const service = new CommitJournalService({
      store,
      projectRoot,
      idFactory: () => "journal-fenced",
      now: () => new Date("2026-07-10T00:00:00.000Z"),
      afterStage: (stage) => {
        if (stage !== "temp_written") {
          return;
        }
        const lease = store.getWriteLease(path.join(projectRoot, "02_正文", "第一章.txt"));
        expect(lease).not.toBeNull();
        store.releaseWriteLease({
          target_path: lease!.target_path,
          owner: lease!.owner,
          fencing_token: lease!.fencing_token,
          expected_version: lease!.version,
          released_at: "2026-07-10T00:00:01.000Z"
        });
        store.acquireWriteLease({
          target_path: lease!.target_path,
          owner: "new-owner",
          acquired_at: "2026-07-10T00:00:02.000Z",
          expires_at: "2026-07-10T00:01:00.000Z"
        });
      }
    });

    await expect(service.write(writeInput())).rejects.toMatchObject({ code: "WRITE_FENCED" });
    expect(await fs.readFile(path.join(projectRoot, "02_正文", "第一章.txt"), "utf8")).toBe("old chapter");
    expect(store.getCommitJournal("journal-fenced")).toMatchObject({ stage: "recovery_required", error_code: "WRITE_FENCED" });
  });
});

async function temporaryProject(): Promise<string> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-commit-journal-"));
  projects.push(project);
  await fs.mkdir(path.join(project, "02_正文"), { recursive: true });
  await fs.writeFile(path.join(project, "02_正文", "第一章.txt"), "old chapter", "utf8");
  return project;
}

function track(store: ExecutionStore): ExecutionStore {
  stores.push(store);
  return store;
}

function writeInput() {
  return {
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    action: "replace_file",
    targetPath: "02_正文/第一章.txt",
    content: "new chapter",
    idempotencyKey: "commit-key-1"
  };
}

function makeRun(projectRoot: string): AgentRunState {
  return {
    schema_version: 1,
    version: 1,
    run_id: "run-1",
    request_id: "request-1",
    conversation_id: "conversation-1",
    project_id: "project-1",
    project_path: projectRoot,
    goal: {
      instruction: "Write a chapter",
      autonomy_mode: "execute",
      requested_outputs: [],
      success_criteria: [],
      assumptions: [],
      blocking_questions: [],
      request_snapshot: { content: "Write a chapter", attachment_refs: [], selected_file_refs: [], settings_snapshot: {}, feature_flag_snapshot: {} }
    },
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
    budget: {
      max_steps: 3,
      max_replans: 1,
      max_attempts_per_step: 2,
      max_duration_ms: 300_000,
      max_input_tokens: 32_000,
      max_output_tokens: 8_000,
      max_cost: 1,
      cost_currency: "USD",
      pricing_snapshot_id: "pricing-1",
      used_steps: 0,
      used_replans: 0,
      used_input_tokens: 0,
      used_output_tokens: 0,
      estimated_cost: 0
    },
    last_event_sequence: 0,
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z"
  } as unknown as AgentRunState;
}

function hash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
