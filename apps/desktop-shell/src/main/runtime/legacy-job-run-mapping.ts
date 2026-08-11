import type { JobInfo, LegacyJobRunMapping } from "@xiaoshuo/shared";

const LEGACY_RUN_PREFIX = "legacy-job:";

/**
 * Projects in-memory JobManager state for display alongside durable Agent runs.
 * No projection is persisted and it never grants Agent resume/retry semantics.
 */
export function mapLegacyJobToRun(job: JobInfo): LegacyJobRunMapping {
  return {
    mapping_version: 1,
    source: "legacy_job_manager",
    legacy_job_id: job.id,
    run_id: legacyJobRunId(job.id),
    job,
    read_only: true,
    recoverable: false,
    agent_control_operations: []
  };
}

export function legacyJobRunId(jobId: string): string {
  return `${LEGACY_RUN_PREFIX}${encodeURIComponent(jobId)}`;
}

export function legacyJobIdFromRunId(runId: string): string | null {
  if (!runId.startsWith(LEGACY_RUN_PREFIX)) {
    return null;
  }
  try {
    const jobId = decodeURIComponent(runId.slice(LEGACY_RUN_PREFIX.length));
    return jobId || null;
  } catch {
    return null;
  }
}
