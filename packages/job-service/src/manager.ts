import type { JobInfo } from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";

export class JobCancelled extends Error {
  constructor(message = "任务已取消") {
    super(message);
    this.name = "JobCancelled";
  }
}

export type JobProgress = (value: number, message?: string) => void;
export type JobWorker<T = unknown> = (progress: JobProgress, signal: AbortSignal) => T | Promise<T>;

export type JobManagerOptions = {
  idFactory?: () => string;
  autoStart?: boolean;
};

type StoredJob = JobInfo & {
  result?: unknown;
  error?: string;
};

export class JobManager {
  private readonly jobs = new Map<string, StoredJob>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly idFactory: () => string;
  private readonly autoStart: boolean;

  constructor(options: JobManagerOptions = {}) {
    this.idFactory = options.idFactory || (() => randomUUID().replaceAll("-", ""));
    this.autoStart = options.autoStart ?? true;
  }

  create<T = unknown>(kind: string, worker: JobWorker<T>): JobInfo {
    const job: StoredJob = {
      id: this.idFactory(),
      kind,
      status: "queued",
      progress: 0,
      message: "排队中"
    };
    const controller = new AbortController();
    this.jobs.set(job.id, job);
    this.controllers.set(job.id, controller);

    if (this.autoStart) {
      queueMicrotask(() => {
        void this.run(job.id, worker, controller);
      });
    }

    return this.clone(job);
  }

  async runQueued<T = unknown>(jobId: string, worker: JobWorker<T>): Promise<JobInfo> {
    const controller = this.controllers.get(jobId);
    if (!controller) {
      throw new KeyError(jobId);
    }
    await this.run(jobId, worker, controller);
    return this.get(jobId);
  }

  get(jobId: string): JobInfo {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new KeyError(jobId);
    }
    return this.clone(job);
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].slice(-50).map((job) => this.clone(job));
  }

  cancel(jobId: string): JobInfo {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new KeyError(jobId);
    }
    this.controllers.get(jobId)?.abort();
    if (job.status === "queued") {
      this.update(jobId, { status: "cancelled", message: "已取消" });
    }
    return this.get(jobId);
  }

  isCancelled(jobId: string): boolean {
    return Boolean(this.controllers.get(jobId)?.signal.aborted);
  }

  private async run<T>(jobId: string, worker: JobWorker<T>, controller: AbortController): Promise<void> {
    if (controller.signal.aborted) {
      this.update(jobId, { status: "cancelled", message: "已取消" });
      return;
    }

    this.update(jobId, { status: "running", message: "执行中", progress: 0 });

    const progress: JobProgress = (value, message = "") => {
      if (controller.signal.aborted) {
        throw new JobCancelled();
      }
      this.update(jobId, {
        progress: clamp01(value),
        message
      });
    };

    try {
      const result = await worker(progress, controller.signal);
      if (controller.signal.aborted) {
        this.update(jobId, { status: "cancelled", message: "已取消" });
        return;
      }
      this.update(jobId, { status: "done", progress: 1, message: "完成", result });
    } catch (error) {
      if (error instanceof JobCancelled || controller.signal.aborted) {
        this.update(jobId, { status: "cancelled", message: "已取消" });
        return;
      }
      this.update(jobId, {
        status: "failed",
        message: "失败",
        error: error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error)
      });
    }
  }

  private update(jobId: string, changes: Partial<StoredJob>): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new KeyError(jobId);
    }
    this.jobs.set(jobId, { ...job, ...changes });
  }

  private clone(job: StoredJob): JobInfo {
    return { ...job };
  }
}

export class KeyError extends Error {
  constructor(key: string) {
    super(key);
    this.name = "KeyError";
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
