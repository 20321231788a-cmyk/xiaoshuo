import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { RunCoordinator } from "./run-coordinator.js";

const repositoryRoot = process.cwd();
const typescriptCli = path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
const childWorker = path.join(repositoryRoot, "packages", "agent-runtime", "evals", "durable-recovery-child.mjs");

beforeAll(() => {
  execFileSync(process.execPath, [typescriptCli, "-p", "packages/shared/tsconfig.json"], { cwd: repositoryRoot, stdio: "pipe" });
  execFileSync(process.execPath, [typescriptCli, "-p", "packages/agent-runtime/tsconfig.json"], { cwd: repositoryRoot, stdio: "pipe" });
}, 60_000);

describe("durable run recovery e2e", () => {
  it("takes over only the second orphaned step after a forced child-process kill and completes the same run id", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "arcwriter-durable-recovery-"));
    let recovery: RunCoordinator | null = null;
    let child: ChildProcess | null = null;
    try {
      child = fork(childWorker, [projectRoot], {
        cwd: repositoryRoot,
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"]
      });
      const message = await waitForReady(child);
      const runId = String(message.run_id || "");
      const firstStepId = String(message.first_step_id || "");
      const secondStepId = String(message.second_step_id || "");
      expect(runId).toMatch(/^run_/);
      expect(firstStepId).toBe("step_fixture_prepare");
      expect(secondStepId).toMatch(/^step_/);

      child.kill("SIGKILL");
      await once(child, "exit");
      await delay(100);

      recovery = new RunCoordinator({
        projectRoot,
        runtimeInstanceId: "runtime-recovery-parent",
        leaseTtlMs: 50,
        autoHeartbeat: false
      });
      const [paused] = recovery.recoverStaleRuns();
      expect(paused).toMatchObject({ run_id: runId, status: "paused", recovery_reason: "RUNTIME_LEASE_EXPIRED" });
      expect(recovery.store.listAttempts(runId, firstStepId)).toMatchObject([
        expect.objectContaining({ attempt: 1, status: "done" })
      ]);
      expect(recovery.store.listAttempts(runId, secondStepId)).toMatchObject([
        expect.objectContaining({ attempt: 1, status: "interrupted", error_code: "RUNTIME_LEASE_EXPIRED" })
      ]);
      expect(recovery.getRun(runId)?.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ step_id: firstStepId, status: "done", attempts: 1 }),
        expect.objectContaining({ step_id: secondStepId, status: "pending", attempts: 1 })
      ]));

      const resumed = recovery.resumeRun(runId, "resume-after-forced-kill", paused!.version);
      expect(resumed).toMatchObject({ run_id: runId, step_id: secondStepId });
      const completed = recovery.completeRun(resumed, {
        intent: "chat",
        reply: "resumed successfully",
        conversation: null,
        results: [],
        skill_result: null,
        saved_paths: [],
        requires_confirmation: false,
        run_id: runId
      });

      expect(completed).toMatchObject({ run_id: runId, status: "completed" });
      expect(recovery.store.listAttempts(runId, secondStepId)).toMatchObject([
        expect.objectContaining({ attempt: 1, status: "interrupted" }),
        expect.objectContaining({ attempt: 2, status: "done" })
      ]);
      expect(recovery.store.listAttempts(runId, firstStepId)).toHaveLength(1);
    } finally {
      if (child?.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
        await once(child, "exit").catch(() => undefined);
      }
      recovery?.close();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

async function waitForReady(child: ChildProcess): Promise<{ run_id?: unknown; first_step_id?: unknown; second_step_id?: unknown }> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const message = await Promise.race([
    once(child, "message").then(([value]) => value),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(`Recovery fixture exited before initialization (code=${code}, signal=${signal}): ${stderr}`);
    })
  ]);
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("Recovery fixture returned an invalid readiness message");
  }
  return message as { run_id?: unknown; first_step_id?: unknown; second_step_id?: unknown };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
