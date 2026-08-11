import { describe, expect, it } from "vitest";
import { legacyJobIdFromRunId, legacyJobRunId, mapLegacyJobToRun } from "./legacy-job-run-mapping.js";

describe("legacy JobManager run mapping", () => {
  it("uses a distinct namespace and preserves the JobManager record as the only state source", () => {
    const job = { id: "crawl/1", kind: "novel_crawl", status: "running" as const, progress: 0.3, message: "抓取中" };

    expect(mapLegacyJobToRun(job)).toEqual({
      mapping_version: 1,
      source: "legacy_job_manager",
      legacy_job_id: "crawl/1",
      run_id: "legacy-job:crawl%2F1",
      job,
      read_only: true,
      recoverable: false,
      agent_control_operations: []
    });
  });

  it("round-trips only the legacy compatibility namespace", () => {
    expect(legacyJobIdFromRunId(legacyJobRunId("job one"))).toBe("job one");
    expect(legacyJobIdFromRunId("run-actual-agent")).toBeNull();
    expect(legacyJobIdFromRunId("legacy-job:%E0%A4")).toBeNull();
  });
});
