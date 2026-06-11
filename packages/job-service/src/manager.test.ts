import { describe, expect, it } from "vitest";
import { JobCancelled, JobManager, KeyError } from "./manager.js";

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("job-service JobManager", () => {
  it("creates queued jobs and completes async workers", async () => {
    const manager = new JobManager({ idFactory: () => "job_1" });

    const created = manager.create("scan_project", async (progress) => {
      progress(0.5, "halfway");
      return { documents: 3 };
    });

    expect(created).toMatchObject({ id: "job_1", kind: "scan_project", status: "queued", progress: 0, message: "排队中" });
    await tick();

    expect(manager.get("job_1")).toMatchObject({
      status: "done",
      progress: 1,
      message: "完成",
      result: { documents: 3 }
    });
  });

  it("clamps progress updates to the Python manager range", async () => {
    const manager = new JobManager({ idFactory: () => "job_1", autoStart: false });
    manager.create("demo", () => "queued");

    await manager.runQueued("job_1", (progress) => {
      progress(2, "too high");
      expect(manager.get("job_1").progress).toBe(1);
      progress(-1, "too low");
      expect(manager.get("job_1").progress).toBe(0);
      return "ok";
    });

    expect(manager.get("job_1").status).toBe("done");
  });

  it("marks thrown workers as failed with an error", async () => {
    const manager = new JobManager({ idFactory: () => "job_1" });

    manager.create("explode", () => {
      throw new Error("boom");
    });
    await tick();

    const job = manager.get("job_1");
    expect(job.status).toBe("failed");
    expect(job.message).toBe("失败");
    expect(job.error).toContain("boom");
  });

  it("cancels queued jobs immediately", () => {
    const manager = new JobManager({ idFactory: () => "job_1", autoStart: false });
    manager.create("queued", () => "never");

    const cancelled = manager.cancel("job_1");

    expect(cancelled).toMatchObject({ status: "cancelled", message: "已取消" });
    expect(manager.isCancelled("job_1")).toBe(true);
  });

  it("cancels running jobs when progress checks cancellation", async () => {
    const manager = new JobManager({ idFactory: () => "job_1", autoStart: false });
    manager.create("running", () => "queued");

    await manager.runQueued("job_1", async (progress) => {
      progress(0.1, "started");
      manager.cancel("job_1");
      progress(0.2, "should throw");
    });

    expect(manager.get("job_1")).toMatchObject({ status: "cancelled", message: "已取消" });
  });

  it("treats explicit JobCancelled as cancelled", async () => {
    const manager = new JobManager({ idFactory: () => "job_1" });

    manager.create("cancel", () => {
      throw new JobCancelled();
    });
    await tick();

    expect(manager.get("job_1").status).toBe("cancelled");
  });

  it("lists only the latest 50 jobs", () => {
    let nextId = 0;
    const manager = new JobManager({ idFactory: () => `job_${++nextId}`, autoStart: false });

    for (let index = 0; index < 55; index += 1) {
      manager.create("demo", () => null);
    }

    const jobs = manager.list();
    expect(jobs).toHaveLength(50);
    expect(jobs[0]?.id).toBe("job_6");
    expect(jobs.at(-1)?.id).toBe("job_55");
  });

  it("throws KeyError for missing jobs", () => {
    const manager = new JobManager();

    expect(() => manager.get("missing")).toThrow(KeyError);
    expect(() => manager.cancel("missing")).toThrow(KeyError);
  });
});
